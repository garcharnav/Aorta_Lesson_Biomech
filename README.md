# Aorta Flow Lab

An in-browser lesson for middle and high school students that compares blood-flow simulations of a **healthy aorta** and an **aorta with coarctation** (a narrowing). It follows the *Simulation Post-Processing* ParaView worksheet: the page looks and behaves like a small ParaView, so students practise the same steps they would use in the real program, with a worksheet panel beside the views.

Nothing needs to be installed. The page runs entirely in the browser, and nothing a student types leaves their computer.

## What students can do

| Worksheet step | In the page |
| --- | --- |
| Open the files | **Open** → tick `healthy.vtu` and `diseased.vtu` → **OK** → **Apply** |
| 1. Compare the geometries | Rotate, zoom and pan both models; the two views move together (**Link cameras**) |
| 2. Pressure | **Coloring** menu → `pressure`; **Information** tab shows the data ranges |
| 2a. Convert to mmHg | **Calculator**: *Result Array Name* `Pressure (mmHg)`, expression `pressure/1333`, **Apply** |
| 3. Velocities | **Clip** with a plane students drag, tilt by its arrow, or turn to face them with **Camera Normal**; a slider moves it along its normal; **Show Plane** hides it; colour the cut face by `velocity` |
| 4. Streamlines | **Stream Tracer**: students only place the seed sphere (drag it or **Pick on model (P)**), set its Radius and Number Of Points, and click Apply |
| 4d. Opacity | **Styling → Opacity** on the first item in the pipeline |

Also available: Pipeline Browser with eye toggles, Apply / Reset / Delete, Auto Apply, Representation (in the Display section), colour map presets, rescaling, legends, point size and line width, a **Hover probe** that reads values under the mouse, camera buttons (reset, ±X/±Y/±Z), a **Screenshot** button, and side-by-side or single-model layouts.

The worksheet panel ticks off each step as students complete it, saves answers in the browser, and has **Download my answers** (a .txt file) and **Print** buttons. Hint buttons can show where the inlet is, place the seed sphere at the inlet, or set the clip plane used in the handout.

## Run it locally

The page loads its data with `fetch`, so open it through a local web server rather than by double-clicking `index.html`:

```bash
cd Aorta_Lesson_Biomech
python3 -m http.server 8000
# then open http://localhost:8000
```

## Publish with GitHub Pages

1. Push this folder to `main`.
2. On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`.
3. The site appears at `https://<user>.github.io/Aorta_Lesson_Biomech/`.

three.js is bundled in `vendor/`, so the page does not depend on a CDN that a school network might block. Only the web fonts come from Google Fonts, and the page falls back to system fonts without them.

## Files

```
index.html              page layout
css/style.css           styles (light and dark)
js/app.js               viewer, pipeline, filters, properties panel
js/lesson.js            worksheet text, answer boxes, progress checks
js/data.js              data loading, grid sampling, streamline integration
js/expr.js              Calculator expression parser (ParaView-style syntax)
js/colormaps.js         colour map presets
data/<model>/           pre-processed data for each model (about 8 MB in total)
tools/preprocess.py     converts the .vtu results into the files in data/
vendor/three/           three.js r160 (MIT licence)
```

## How the data are prepared

The original results (`healthy.vtu`, 1.39 M tetrahedra; `diseased.vtu`, 3.40 M tetrahedra) are too large to send to a browser, so `tools/preprocess.py` converts each one into:

- **the vessel surface** (wall and inlet/outlet caps) with `pressure`, `velocity`, `average_pressure`, `average_speed` and `vWSS` at every surface point, stored as 16-bit values;
- **the volume solution resampled onto a uniform 0.25 mm grid**, with a signed distance to the wall, used to draw the clip's cut face and to trace streamlines;
- **`meta.json`**, with the original array ranges (shown in the Information tab), bounds, and the detected inlet and outlet caps.

To regenerate the data, for example after a new simulation:

```bash
pip install pyvista scipy
python3 tools/preprocess.py path/to/healthy.vtu path/to/diseased.vtu --out data
```

The script expects point arrays named `pressure`, `velocity`, `average_pressure`, `average_speed` and `vWSS`. The models must be called `healthy` and `diseased`, or the names in `js/app.js` and `js/lesson.js` changed to match.

### Differences from ParaView

- The cut face and streamlines use the resampled grid, so values inside the vessel are interpolated from 0.25 mm voxels rather than from the original tetrahedra. Peak speeds agree to within about 1 % (96.1 cm/s in the original diseased mesh, 95.9 cm/s on the grid).
- Streamlines are integrated with fixed-step fourth-order Runge–Kutta (step 0.125 mm) rather than ParaView's adaptive Runge–Kutta 4-5. Point Cloud seeds are random points in the sphere, with a fixed random seed so every student sees the same result.
- To keep the panels short, some ParaView settings are fixed and hidden. The Clip always uses a plane with Invert on, so Camera Normal shows the cut side, and the Calculator always works on point data. The Stream Tracer always uses velocity, a Point Cloud seed, integration in BOTH directions, Maximum Steps 9000 and Maximum Streamline Length 100 cm. These are set in `STREAM_FIXED` at the top of `js/app.js`.
- Colour maps are shared by array name across both models, as in ParaView, so the healthy and diseased models are always coloured on the same scale unless the range is changed.
- The Information tab gives approximate cell and point counts for a clip.

## Credits

Interface inspired by ParaView and by the [WSS LCS Explorer](https://amir-cardiolab.github.io/WSS-topology/) ([source](https://github.com/amir-cardiolab/WSS-topology)). Rendering with [three.js](https://threejs.org). Fonts: Atkinson Hyperlegible Next and Source Serif 4.
