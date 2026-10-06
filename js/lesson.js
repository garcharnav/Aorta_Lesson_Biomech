// The worksheet panel: the handout's steps and questions, answer boxes, and live progress checks.

const STORE = 'aortaLab.worksheet.v1';
const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const save = (d) => { try { localStorage.setItem(STORE, JSON.stringify(d)); return true; } catch { return false; } };

const QUESTIONS = {
  q1: 'What is different about the healthy and diseased geometries?',
  q2: 'Are the pressure values large?',
  q2b: 'What is different about the pressure of the two aorta models? How does pressure change in the diseased aorta with coarctation?',
  q3: 'What do you notice about the velocities in the two different models?',
  q4: 'What do you notice about the streamlines between the two models? How is the blood flow different in each model?',
};

const ui = (t) => `<span class="ui">${t}</span>`;
const box = (id) => `<label class="sr" for="ans-${id}">${QUESTIONS[id]}</label><textarea class="answer" id="ans-${id}" data-q="${id}" placeholder="Type your answer here"></textarea>`;

const HTML = `
<div class="sheet">
  <div class="name-row"><label for="ws-name">Name:</label><input id="ws-name" autocomplete="name"></div>
  <h1>Simulation Post-Processing</h1>
  <p class="intro">You will explore computer simulations of blood flowing through two aortas, the large artery that carries blood out of the heart. The tools here work like ParaView, the program engineers use to look at simulation results.</p>
  <ol class="steps">
    <li class="step prep" data-step="0">
      <p><b>Open the files.</b> Click ${ui('Open')} at the top left, tick <i>healthy.vtu</i> and <i>diseased.vtu</i>, and click ${ui('OK')}. Then click the green ${ui('Apply')} button.</p>
      <dl class="navhelp">
        <dt>Rotate</dt><dd>drag with the left mouse button</dd>
        <dt>Zoom</dt><dd>scroll, or drag with the middle button</dd>
        <dt>Move</dt><dd>drag with the right mouse button</dd>
        <dt>Lost it?</dt><dd>click the reset camera button (the frame icon)</dd>
      </dl>
      <ul class="checks" data-checks="open"></ul>
    </li>
    <li class="step numbered" data-step="1">
      <p class="q">We will look at two aorta models. What is different about the healthy and diseased geometries? <i>Hint: Rotate to get a better look!</i></p>
      ${box('q1')}
    </li>
    <li class="step numbered" data-step="2">
      <p class="q"><b class="kw">Pressure:</b> Change the data you are looking at to pressure using the ${ui('Coloring')} menu in the toolbar. Are the values large?</p>
      ${box('q2')}
      <ul class="checks" data-checks="pressure"></ul>
      <p>The values are quite high! They are in units of dynes/cm². Doctors usually look at blood pressure in mmHg, and it should be between 70 and 100 mmHg. We will convert them to units of mmHg using the ${ui('Calculator')}.</p>
      <ol class="sub">
        <li>Click <i>healthy.vtu</i> in the Pipeline Browser, then click ${ui('Calculator')}. Change <b>Result Array Name</b> to <code class="ex">Pressure (mmHg)</code>, and in the expression box underneath write <code class="ex">pressure/1333</code>. Click ${ui('Apply')}. Repeat for <i>diseased.vtu</i>.
          <p class="note">1 mmHg = 1333 dynes/cm², so dividing by 1333 changes the units to mmHg.</p>
          <ul class="checks" data-checks="calc"></ul>
        </li>
        <li><span class="q">What is different about the pressure of the two aorta models? How does pressure change in the diseased aorta with coarctation?</span>
          <p class="note">Tip: turn on ${ui('Hover probe')} to read the value under your mouse.</p>
          ${box('q2b')}
        </li>
      </ol>
    </li>
    <li class="step numbered" data-step="3">
      <p class="q">Now we will look at <b class="kw">velocities</b>. Select <i>Calculator1</i> in the Pipeline Browser and click ${ui('Clip')}. Align the plane so it cuts the aorta lengthwise, like slicing a straw in half along its length. Click ${ui('Apply')}. <b>Make sure velocity is selected</b> in the ${ui('Coloring')} menu! Then <b>uncheck</b> ${ui('Show Plane')} to view the model. Repeat for the diseased model.</p>
      <p class="note">To tilt the plane, drag the tip of its arrow. Or rotate the view until you look straight at the side of the arch, then click ${ui('Camera Normal')}.<br>
        <button type="button" class="hintbtn" data-hint="plane">Show me the plane from the handout</button></p>
      <ul class="checks" data-checks="clip"></ul>
      <ol class="sub">
        <li><span class="q">What do you notice about the velocities in the two different models?</span>${box('q3')}</li>
      </ol>
    </li>
    <li class="step numbered" data-step="4">
      <p class="q">Next we will look at <b class="kw">streamlines</b>. These show us where the blood is flowing.</p>
      <ol class="sub">
        <li>Select <i>Calculator1</i> again and click the ${ui('Stream Tracer')} button.</li>
        <li>Make sure <b>Vectors</b> is velocity. Change <b>Seed Type</b> to <b>Point Cloud</b>, then position the sphere around the inlet of the aorta, where blood comes in from the heart. Drag the sphere, or use ${ui('Pick on model (P)')}.
          <br><button type="button" class="hintbtn" data-hint="inlet">Where is the inlet?</button><button type="button" class="hintbtn" data-hint="seed">Put the sphere at the inlet for me</button></li>
        <li>Change <b>Number Of Points</b> to <code class="ex">200</code> and <b>Maximum Streamline Length</b> to <code class="ex">20</code>. Click ${ui('Apply')}, then set ${ui('Coloring')} to velocity. Repeat for the diseased model.</li>
        <li>Then change the opacity of the model by clicking on the very first item in your pipeline (<i>healthy.vtu</i> or <i>diseased.vtu</i>). Click its eye so the model is showing, then in the <b>Styling</b> section of Properties, change <b>Opacity</b> to <code class="ex">0.2</code>. Hide the Clip by clicking its eye. That will help you see the streamlines.
          <ul class="checks" data-checks="stream"></ul>
        </li>
        <li><span class="q">What do you notice about the streamlines between the two models? How is the blood flow different in each model?</span>${box('q4')}</li>
      </ol>
    </li>
  </ol>
  <div class="finish">
    <button type="button" class="primary" id="ws-download">Download my answers</button>
    <button type="button" id="ws-print">Print</button>
    <span class="saved" id="ws-saved" aria-live="polite"></span>
  </div>
</div>`;

export function initLesson(root, app) {
  root.innerHTML = HTML;
  const data = load();
  const name = root.querySelector('#ws-name');
  name.value = data.name || '';
  const saved = root.querySelector('#ws-saved');
  const persist = () => {
    data.name = name.value;
    for (const t of root.querySelectorAll('.answer')) data[t.dataset.q] = t.value;
    saved.textContent = save(data) ? 'Answers are saved in this browser.' : 'This browser cannot save answers; download them before you leave.';
    refresh();
  };
  name.addEventListener('input', persist);
  for (const t of root.querySelectorAll('.answer')) { t.value = data[t.dataset.q] || ''; t.addEventListener('input', persist); }

  root.querySelector('#ws-download').addEventListener('click', () => {
    const lines = [`Simulation Post-Processing`, `Name: ${name.value}`, ''];
    for (const [id, q] of Object.entries(QUESTIONS)) lines.push(q, (root.querySelector(`#ans-${id}`).value || '(no answer)').trim(), '');
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `aorta-worksheet${name.value ? '-' + name.value.trim().replace(/\s+/g, '-') : ''}.txt`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  root.querySelector('#ws-print').addEventListener('click', () => window.print());

  // ----- hint buttons
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-hint]');
    if (!b) return;
    const sel = app.S.selected;
    if (b.dataset.hint === 'inlet') app.flashInlet();
    if (b.dataset.hint === 'plane') {
      if (!sel || sel.type !== 'clip') { app.status('First select a Clip item in the Pipeline Browser.', true); return; }
      const p = app.archPlane(sel.model);
      // point the normal toward the viewer so the cut face (kept by Invert) faces the camera
      const cam = app.cameraPos(sel.model), d = [0, 1, 2].map((i) => cam[i] - p.origin[i]);
      let n = p.normal.slice();
      if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0) n = n.map((x) => -x);
      if (!sel.edit.invert) n = n.map((x) => -x);
      app.setEdit(sel, 'origin', p.origin.map((x) => +x.toFixed(5)));
      app.setEdit(sel, 'normal', n.map((x) => +x.toFixed(5)));
      app.status('Plane set. Click Apply to cut the model.', false, 4000);
    }
    if (b.dataset.hint === 'seed') {
      if (!sel || sel.type !== 'stream') { app.status('First select a StreamTracer item in the Pipeline Browser.', true); return; }
      const s = app.inletSeed(sel.model);
      app.setEdit(sel, 'seedType', 'Point Cloud');
      app.setEdit(sel, 'center', s.center);
      app.setEdit(sel, 'radius', s.radius);
      app.select(sel);
      app.status('Sphere placed at the inlet. Click Apply when you are ready.', false, 4000);
    }
  });

  // ----- progress checks
  const S = app.S, models = ['healthy', 'diseased'], label = { healthy: 'healthy', diseased: 'diseased' };
  const nodes = (m, type) => app.nodesOf(m).filter((n) => n.applied && (!type || n.type === type));
  const calcOK = (m) => nodes(m, 'calculator').some((n) => {
    if (!/mmhg/i.test(n.props.resultName)) return false;
    const r = app.sampleCalc(n);
    return r && r.every((x) => Math.abs(x - 1) < 0.01);
  });
  const clipOK = (m) => nodes(m, 'clip').some((n) => n.display.colorBy === 'velocity');
  const planeHidden = (m) => nodes(m, 'clip').some((n) => !n.edit.showPlane);
  const nearInlet = (n) => {
    const s = app.inletSeed(n.model), c = n.props.center;
    return Math.hypot(c[0] - s.center[0], c[1] - s.center[1], c[2] - s.center[2]) < s.radius * 1.6;
  };
  const streams = (m) => nodes(m, 'stream').filter((n) => n.props.seedType === 'Point Cloud');
  const CHECKS = {
    open: () => models.map((m) => [`${label[m]}.vtu opened and applied`, nodes(m, 'source').length > 0]),
    pressure: () => [['A model is colored by pressure', S.nodes.some((n) => n.applied && n.visible && n.display.colorBy === 'pressure')]],
    calc: () => models.map((m) => [`Pressure (mmHg) made for the ${label[m]} model`, calcOK(m)]),
    clip: () => models.flatMap((m) => [[`${label[m]} model clipped and colored by velocity`, clipOK(m)], [`${label[m]} plane hidden`, planeHidden(m)]]),
    stream: () => models.flatMap((m) => [
      [`${label[m]}: point cloud at the inlet`, streams(m).some(nearInlet)],
      [`${label[m]}: 200 points, length 20`, streams(m).some((n) => Math.round(n.props.numPoints) === 200 && Math.abs(n.props.maxLength - 20) < 1e-6)],
      [`${label[m]}: streamlines colored by velocity`, streams(m).some((n) => n.visible && n.display.colorBy === 'velocity')],
      [`${label[m]}: model opacity 0.2`, app.nodesOf(m).some((n) => n.applied && n.visible && n.type !== 'stream' && n.display.opacity <= 0.25)],
    ]),
  };
  const STEP_KEYS = { 0: ['open'], 1: [], 2: ['pressure', 'calc'], 3: ['clip'], 4: ['stream'] };
  const STEP_Q = { 0: [], 1: ['q1'], 2: ['q2', 'q2b'], 3: ['q3'], 4: ['q4'] };

  function refresh() {
    const done = {};
    for (const [key, fn] of Object.entries(CHECKS)) {
      const ul = root.querySelector(`[data-checks="${key}"]`);
      const items = fn();
      done[key] = items.every(([, ok]) => ok);
      ul.innerHTML = items.map(([t, ok]) => `<li class="${ok ? 'done' : ''}"><span class="tick" aria-hidden="true"></span><span>${t}<span class="sr">${ok ? ' (done)' : ' (not yet)'}</span></span></li>`).join('');
    }
    let current = null;
    for (const s of Object.keys(STEP_KEYS)) {
      const complete = STEP_KEYS[s].every((k) => done[k]) && STEP_Q[s].every((q) => (data[q] || '').trim().length > 0);
      if (!complete && current === null) current = s;
    }
    for (const li of root.querySelectorAll('.step')) li.classList.toggle('current', li.dataset.step === current);
  }
  app.onChange(refresh);
  refresh();
}
