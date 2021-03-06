'use strict';

var gd = document.getElementById('graph');

function zeros (n) {
  return ndarray(new Array(n));
}

// Grid definition:
var grid = {
  xmin: 0,
  xmax: 2,
  n: 512,
};

// Initial pulse:
var pulse = {
  center: grid.xmin + (grid.xmax - grid.xmin) * 0.25,
  width: 0.1,
  magnitude: 1,
  wavenumber: 200.0
};

var pulse2 = {
  center: grid.xmin + (grid.xmax - grid.xmin) * 0.75,
  width: 0.1,
  magnitude: 0,
  wavenumber: -200.0
};

// Perfectly Matched Layer (PML):
var pml = {
  width: 0.05,
  exponent: 1,
  gamma: Math.PI * 0.5
};

var integration = {
  dt: 1e-4,
  stepsPerIter: 5,
  method: 'rk4'
}

// Potential barrier:
var potential = {
  width: 0.1,
  magnitude: 1000,
  inverted: false,
  //offset: 0,
  center: grid.xmin + (grid.xmax - grid.xmin) * 0.5,
  exponent: 2,
};

var simulationConfig = {
  pulse: pulse,
  pulse2: pulse2,
  pml: pml,
  integration: integration,
  potential: potential
}

paramsFromHash();

console.log('CFL number = ', integration.dt / Math.pow((grid.xmax - grid.xmin) / (grid.n - 1), 2));

// Initial conditions:
var x = linspace(zeros(grid.n), grid.xmin, grid.xmax, grid.n);
var y = pool.zeros([grid.n, 2])
var yp = pool.zeros([grid.n, 2])
var yr = y.pick(null, 0);
var yi = y.pick(null, 1);

// Time integration
var integrators = {
  euler: euler(y.data, deriv, 0, integration.dt),
  rk2: rk2(y.data, deriv, 0, integration.dt),
  rk4: rk4(y.data, deriv, 0, integration.dt),
};

// Potential:
var V = ndarray(new Array(grid.n));

function computePotential () {
  fill(V, function (i) {
    var xnorm = (x.get(i) - potential.center) / potential.width;
    var gaussian = Math.exp(-Math.pow(Math.abs(xnorm), potential.exponent));
    if (potential.inverted) {
      gaussian = 1 - gaussian;
    }
    // Tweak this *slightly* to allow no potential:
    var mag = potential.magnitude < 1.0001 ? 0 : potential.magnitude;
    return mag * gaussian;
  });
}

var PML = pool.zeros([grid.n, 2]);
var PMLr = PML.pick(null, 0);
var PMLi = PML.pick(null, 1);
var sigmaEval = zeros(grid.n);

function sigma (x) {
  var xnorm = (x - grid.xmin) / (grid.xmax - grid.xmin)
  if (xnorm < pml.width || xnorm > 1 - pml.width) {
    return Math.pow(Math.max(0, Math.min(1, (Math.abs(x / (grid.xmax - grid.xmin) - 0.5) * 2 - 1 + pml.width * 2) / (pml.width * 2))), pml.exponent);
  } else {
    return 0;
  }
}

function computeSigma () {
  fill(sigmaEval, function (i) { return sigma(x.get(i)); });
}

var tabulatePML = cwise({
  args: ['array', 'array', 'array', 'scalar'],
  body: function (x, PMLr, PMLi, config) {
    var sigma = config.sigma(x);
    var a = 1 + sigma * Math.cos(config.gamma);
    var b = sigma * Math.sin(config.gamma);
    var denom = a * a + b * b;
    PMLr = a / denom;
    PMLi = -b / denom;
  }
});

function computePML () {
  computeSigma();
  tabulatePML(x, PMLr, PMLi, {sigma: sigma, gamma: pml.gamma});
}

var applyPML = cwise({
  args: ['array', 'array', 'array', 'array'],
  body: function (ypr, ypi, PMLr, PMLi) {
    var a = ypr;
    var b = ypi;
    ypr = a * PMLr - b * PMLi;
    ypi = a * PMLi + b * PMLr;
  }
});

var pl = {
  yr: zeros(grid.n),
  yi: zeros(grid.n),
  ypabs: zeros(grid.n),
  ymabs: zeros(grid.n),
};

function fftfreq (n, dx) {
  var f = pool.zeros([n]);
  for (var i = 0; i < n; i++) {
    f.set(i, (i < Math.floor((n + 1) / 2)) ?  i / (n * dx) : -(n - i) / (n * dx));
  }
  return f;
}

var computeComponents = cwise({
  args: ['array', 'array', 'array', 'array', 'array', 'array'],
  body: function (reOut, imOut, pAbsOut, mAbsOut, reIn, imIn) {
    var abs = Math.sqrt(reIn * reIn + imIn * imIn);
    reOut = reIn,
    imOut = imIn,
    pAbsOut = abs;
    mAbsOut = -abs;
  }
});

var initializeSolution = cwise({
  args: ['array', 'array', 'array', 'scalar', 'scalar', 'scalar'],
  body: function (x, yr, yi, pulse, pulse2) {
    var mag = Math.exp(-Math.pow((x - pulse.center)/pulse.width, 2)) * pulse.magnitude;
    yr = Math.cos(x * pulse.wavenumber) * mag;
    yi = Math.sin(x * pulse.wavenumber) * mag;

    mag = Math.exp(-Math.pow((x - pulse2.center)/pulse2.width, 2)) * pulse2.magnitude;
    yr += Math.cos(x * pulse2.wavenumber) * mag;
    yi += Math.sin(x * pulse2.wavenumber) * mag;
  },
});

// Compute ik * fft(y)
var fftDeriv = cwise({
  args: ['array', 'array', 'array'],
  body: function (k, re, im) {
    var tmp = re;
    re = -im * k
    im = tmp * k
  }
});

// A dummy ndarray that we'll use to pass data to the fft:
var yt = ndarray(y.data, y.shape, y.stride, y.offset);
var yt2 = ndarray(y.data, y.shape, y.stride, y.offset);
var ytr = yt.pick(null, 0);
var yti = yt.pick(null, 1);
var ytmp = new Float64Array(grid.n * 2);

// This differentiates an ndarray but *requires* that
// re.data === im.data:
var k = fftfreq(grid.n, (grid.xmax - grid.xmin) / (grid.n - 1));
function differentiate (re, im) {
  fft(1, re, im);
  fftDeriv(k, re, im);
  fft(-1, re, im);
}

// Multiply by -i:
var scale = cwise({
  args: ['array', 'array', 'array', 'array', 'array'],
  body: function (ypRe, ypIm, yRe, yIm, V) {
    // Compute real and imaginary components:
    var re = -ypRe + V * yRe;
    var im = -ypIm + V * yIm;

    // Multiply by -i and write back into yp:
    ypRe = im;
    ypIm = -re;
  }
});

// Dummy ndarrays for holding the re/im parts of y and dydt:
var yrTmp = ndarray(yr.data, yr.shape, yr.stride, yr.offset);
var yiTmp = ndarray(yi.data, yi.shape, yi.stride, yi.offset);
var yprTmp = ndarray(yr.data, yr.shape, yr.stride, yr.offset);
var ypiTmp = ndarray(yi.data, yi.shape, yi.stride, yi.offset);

// The main derivative function for ODE:
function deriv (dydt, y, t) {
  yrTmp.data = y;
  yiTmp.data = y;
  yprTmp.data = dydt;
  ypiTmp.data = dydt;

  // Copy dydt <- y
  dydt.set(y);

  // Differentiate twice:
  differentiate(yprTmp, ypiTmp);
  applyPML(yprTmp, ypiTmp, PMLr, PMLi);
  differentiate(yprTmp, ypiTmp);
  applyPML(yprTmp, ypiTmp, PMLr, PMLi);

  // Multiply by -i:
  scale(yprTmp, ypiTmp, yrTmp, yiTmp, V);
}

function initialize () {
  computePotential();
  computePML();
  initializeSolution(x, yr, yi, pulse, pulse2);
  computeComponents(pl.yr, pl.yi, pl.ypabs, pl.ymabs, yr, yi);
}

function reinitialize () {
  initialize();

  return redrawSolution().then(function () {
    return redrawExtras();
  }).then(function () {
    return Plotly.redraw(gd);
  });
}

function reinitializeWithRestart () {
  execute(reinitialize);
}

function redrawExtras () {
  return Plotly.transition(gd, [{y: V.data}, {
    y: sigmaEval.data,
    fillopacity: Math.random()
  }], null, [4, 5], {duration: 0});
}

function redrawSolution () {
  // Copy the solution into plottable arrays:
  computeComponents(pl.yr, pl.yi, pl.ypabs, pl.ymabs, yr, yi);

  return Plotly.transition(gd, [
    {y: pl.yr.data},
    {y: pl.yi.data},
    {y: pl.ymabs.data},
    {y: pl.ypabs.data},
  ], null, [0, 1, 2, 3], {
    duration: 0,
  });
}

function rescaleY2 () {
  return Plotly.relayout(gd, {
    'yaxis2.range': computePotentialAxisLimits()
  });
}

var raf;
function iterate () {
  // Take a number of steps of the integrator:
  integrators[integration.method].steps(integration.stepsPerIter);

  redrawSolution();

  raf = requestAnimationFrame(iterate);
}

function start () {
  if (raf) return;
  raf = requestAnimationFrame(iterate);
}

function stop () {
  cancelAnimationFrame(raf);
  raf = null;
}

function startStop () {
  if (isRunning()) {
    stop();
  } else {
    start();
  }
}

function isRunning () {
  return !!raf;
}

function execute (cb) {
  var needsRestart = isRunning();

  //if (needsRestart) {
    //stop();
  //}
  return Promise.resolve().then(function () {
    return cb();
  }).then(function () {
    //if (needsRestart) {
      //start();
    //}
  });
}

initialize();
start();

function computePotentialAxisLimits () {
  var mag = Math.max(1000, Math.abs(potential.magnitude) * 1.5);
  return [-mag, mag];
}

Plotly.plot(gd, [
    {
      x: x.data,
      y: pl.yr.data,
      line: {width: 1, color: 'blue', simplify: false},
      showlegend: false,
      hoverinfo: 'none',
    },
    {
      x: x.data,
      y: pl.yi.data,
      line: {width: 1, color: 'green', simplify: false},
      showlegend: false,
      hoverinfo: 'none',
    },
    {
      x: x.data,
      y: pl.ymabs.data,
      line: {width: 2, color: 'black', simplify: false},
      showlegend: false,
      hoverinfo: 'none',
    },
    {
      x: x.data,
      y: pl.ypabs.data,
      fill: 'tonexty',
      fillcolor: 'rgba(100, 150, 200, 0.3)',
      line: {width: 2, color: 'black', simplify: false},
      showlegend: false,
      hoverinfo: 'none',
    },
    {
      x: x.data,
      y: V.data,
      fill: 'tozeroy',
      fillcolor: 'rgba(200, 50, 50, 0.2)',
      line: {width: 2, color: 'red', simplify: false},
      showlegend: false,
      hoverinfo: 'none',
      yaxis: 'y2',
    },
    {
      x: x.data,
      y: sigmaEval.data,
      fill: 'tozeroy',
      fillcolor: 'rgba(128, 128, 128, 0.2)',
      line: {width: 2, color: '#ccc', simplify: true},
      showlegend: false,
      hoverinfo: 'none',
    },
  ],
  {
    xaxis: {
      range: [grid.xmin, grid.xmax]
    },
    yaxis: {
      range: [-1.5, 1.5],
    },
    yaxis2: {
      range: computePotentialAxisLimits(),
      overlaying: 'y',
      side: 'right'
    },
    margin: {t: 30, r: 40, b: 40, l: 40}
  }, {scrollZoom: true}
).then(onResize);

control([
  {type: 'range', label: 'dt', min: 1e-5, max: 1e-3, initial: integration.dt},
  {type: 'range', label: 'stepsPerIter', min: 1, max: 20, initial: integration.stepsPerIter, step: 1},
  {type: 'select', label: 'method', options: ['euler', 'rk2', 'rk4'], initial: integration.method},
  {type: 'button', label: 'Reinitialize', action: reinitializeWithRestart},
  {type: 'button', label: 'Start/Stop', action: startStop},
], {
  root: document.getElementById('simulation-control'),
  title: 'Simulation',
  theme: 'light',
}).on('input', function (data) {
  extend(integration, data);
  integrators[integration.method].dt = data.dt;
  paramsToHash();
});


control([
  {type: 'range', label: 'magnitude', min: 0, max: 1, initial: pulse.magnitude},
  {type: 'range', label: 'width', min: 0, max: 0.2, initial: pulse.width},
  {type: 'range', label: 'wavenumber', min: -400, max: 400, initial: pulse.wavenumber, step: 1},
  {type: 'range', label: 'center', min: grid.xmin, max: grid.xmax, initial: pulse.center, step: 0.01},
], {
  root: document.getElementById('pulse-1-control'),
  title: 'Pulse 1',
  theme: 'light',
}).on('input', function (data) {
  execute(function () {
    extend(pulse, data);
    paramsToHash();
    reinitialize();
  });
});

control([
  {type: 'range', label: 'magnitude', min: 0, max: 1, initial: pulse2.magnitude},
  {type: 'range', label: 'width', min: 0, max: 0.2, initial: pulse2.width},
  {type: 'range', label: 'wavenumber', min: -400, max: 400, initial: pulse2.wavenumber, step: 1},
  {type: 'range', label: 'center', min: grid.xmin, max: grid.xmax, initial: pulse2.center, step: 0.01},
], {
  root: document.getElementById('pulse-2-control'),
  title: 'Pulse 2',
  theme: 'light',
}).on('input', function (data) {
  execute(function () {
    extend(pulse2, data);
    paramsToHash();
    reinitialize();
  });
});

control([
  {type: 'range', label: 'exponent', min: 0, max: 5, initial: pml.exponent},
  {type: 'range', label: 'width', min: 0, max: 0.5, initial: pml.width, step: 0.01},
  {type: 'range', label: 'gamma', min: 0, max: Math.PI * 0.5, initial: pml.gamma, steps: 101},
], {
  root: document.getElementById('pml-control'),
  title: 'Perfectly Matched Layer',
  theme: 'light',
}).on('input', function (data) {
  execute(function () {
    extend(pml, data);
    computePML();
    paramsToHash();
    return Plotly.redraw(gd);
  });
});

control([
  {type: 'range', label: 'magnitude', min: 0, max: 1e4, initial: potential.magnitude, steps: 100},
  {type: 'range', label: 'width', min: 0, max: 1, initial: potential.width},
  //{type: 'range', label: 'offset', min: 1, max: 1e4, initial: potential.offset, scale: 'log'},
  {type: 'range', label: 'center', min: grid.xmin, max: grid.xmax, initial: potential.center, step: 0.01},
  {type: 'range', label: 'exponent', min: 1, max: 50, initial: potential.exponent},
  {type: 'checkbox', label: 'inverted', initial: potential.inverted},
], {
  root: document.getElementById('potential-control'),
  title: 'Potential Barrier',
  theme: 'light',
}).on('input', function (data) {
  execute(function () {
    extend(potential, data);
    computePotential();
    paramsToHash();
    rescaleY2().then(function () {
      return Plotly.redraw(gd);
    });
  });
});

function onResize () {
  return Plotly.relayout(gd, {
    width: window.innerWidth - 300,
    height: window.innerHeight,
  });
}

window.addEventListener('resize', onResize);

function paramsFromHash () {
  try {
    var str = window.location.hash.replace(/^#/,'');
    var parsed = qs.parse(str);
    var fields = ['pulse', 'pulse2', 'pml', 'potential', 'integration'];
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var fieldData = parsed[field];
      var fieldConfig = simulationConfig[field];
      if (!fieldConfig) continue;
      try {
        var fieldValue = JSON.parse(fieldData);
        extend(simulationConfig[field], fieldValue);
      } catch (e) {
        console.warn(e);
      }
    }
  } catch(e) {
    console.warn(e);
  }
}

function paramsToHash () {
  var params = qs.stringify({
    pulse: JSON.stringify(pulse),
    pulse2: JSON.stringify(pulse2),
    pml: JSON.stringify(pml),
    integration: JSON.stringify(integration),
    potential: JSON.stringify(potential),
  });

  window.location.hash = params;
}

