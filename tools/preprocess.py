#!/usr/bin/env python3
"""Convert the healthy/diseased aorta CFD results (.vtu) into compact files for the web lesson.

For each model this writes, into <out>/<name>/:
  surface.bin.gz  wall + cap surface (positions, triangles) with point arrays quantised to uint16
  grid.bin.gz     the volume solution resampled onto a uniform grid (signed distance to the wall,
                  velocity, pressure, average_pressure, average_speed) for clipping and streamlines
  meta.json       sizes, quantisation ranges, bounds, inlet/outlet caps and dataset information

Usage:  python3 preprocess.py healthy.vtu diseased.vtu --out data [--h 0.025]
Requires: numpy, scipy, pyvista (pip install pyvista scipy)
"""
import argparse, gzip, json, os, time
import numpy as np
import pyvista as pv
import vtk
from scipy import ndimage

SURF_ARRAYS = [("pressure", 1), ("velocity", 3), ("average_pressure", 1), ("average_speed", 1), ("vWSS", 3)]


def quantise(a):
    """Quantise each component of a to uint16 over its own [min, max]."""
    a = np.asarray(a, dtype=np.float64)
    if a.ndim == 1:
        a = a[:, None]
    lo, hi = a.min(0), a.max(0)
    span = np.where(hi > lo, hi - lo, 1.0)
    q = np.round((a - lo) / span * 65535).astype(np.uint16)
    return q, lo.tolist(), hi.tolist()


def find_caps(surf):
    """Planar rings bounding the flat inlet/outlet caps, found from sharp feature edges."""
    fe = surf.extract_feature_edges(feature_angle=45, boundary_edges=False, non_manifold_edges=False,
                                    manifold_edges=False, feature_edges=True).connectivity()
    caps = []
    for r in np.unique(fe["RegionId"]):
        P = fe.extract_cells(np.where(fe["RegionId"] == r)[0]).points
        if len(P) < 20:
            continue
        c = P.mean(0)
        _, sv, vt = np.linalg.svd(P - c)
        if sv[2] / sv[0] > 0.01:      # not planar: a crease, not a cap
            continue
        caps.append(dict(center=c, normal=vt[2], radius=float(np.linalg.norm(P - c, axis=1).mean())))
    return caps


def orient_caps(caps, mesh):
    """Make every cap normal point into the fluid and label inlet / outlets."""
    loc = vtk.vtkStaticCellLocator(); loc.SetDataSet(mesh); loc.BuildLocator()
    for cap in caps:
        probe = cap["center"] + cap["normal"] * cap["radius"] * 0.5
        if loc.FindCell(probe) < 0:
            cap["normal"] = -cap["normal"]
    caps.sort(key=lambda c: -c["radius"])
    # the two big caps are the aortic root (inlet) and the descending outlet; the inlet sits higher
    big = sorted(caps[:2], key=lambda c: -c["center"][2])
    big[0]["role"], big[1]["role"] = "inlet", "descending outlet"
    for c in caps[2:]:
        c["role"] = "branch outlet"
    return [dict(role=c["role"], center=np.round(c["center"], 5).tolist(),
                 normal=np.round(c["normal"], 5).tolist(), radius=round(c["radius"], 5)) for c in caps]


def process(path, name, out, h):
    t0 = time.time()
    mesh = pv.read(path)
    print(f"[{name}] {mesh.n_points} points, {mesh.n_cells} cells")
    info_arrays = []
    for arr in ["GlobalNodeID", "pressure", "velocity", "average_pressure", "average_speed", "vWSS",
                "vinplane_traction", "timeDeriv"]:
        a = np.asarray(mesh.point_data[arr])
        if a.ndim == 1:
            rng = [[float(a.min()), float(a.max())]]
        else:
            rng = [[float(a[:, i].min()), float(a[:, i].max())] for i in range(a.shape[1])]
            mag = np.linalg.norm(a, axis=1)
            rng.append([float(mag.min()), float(mag.max())])
        info_arrays.append(dict(name=arr, ncomp=1 if a.ndim == 1 else a.shape[1], ranges=rng))

    # ---------- surface ----------
    surf = mesh.extract_surface(algorithm="dataset_surface").triangulate().clean()
    surf = surf.compute_normals(point_normals=True, cell_normals=False, auto_orient_normals=True,
                                consistent_normals=True, split_vertices=False)
    faces = surf.faces.reshape(-1, 4)[:, 1:].astype(np.uint32)
    pos = np.asarray(surf.points, dtype=np.float32)
    blobs = [pos.tobytes(), faces.tobytes()]
    surf_meta = dict(nverts=int(len(pos)), ntris=int(len(faces)), arrays=[])
    for arr, nc in SURF_ARRAYS:
        q, lo, hi = quantise(surf.point_data[arr])
        blobs.append(q.tobytes())
        surf_meta["arrays"].append(dict(name=arr, ncomp=nc, lo=lo, hi=hi))
    os.makedirs(os.path.join(out, name), exist_ok=True)
    with gzip.open(os.path.join(out, name, "surface.bin.gz"), "wb", compresslevel=9) as f:
        for b in blobs:
            f.write(b)
    caps = orient_caps(find_caps(surf), mesh)

    # ---------- uniform grid ----------
    b = np.array(mesh.bounds).reshape(3, 2)
    lo = b[:, 0] - 2 * h
    dims = np.ceil((b[:, 1] + 2 * h - lo) / h).astype(int) + 1
    img = pv.ImageData(dimensions=dims, spacing=(h, h, h), origin=lo)
    print(f"[{name}] grid {dims.tolist()} = {np.prod(dims)} voxels, h = {h}")
    sampled = img.sample(mesh, pass_point_data=False)
    valid = np.asarray(sampled["vtkValidPointMask"]).astype(bool)

    # signed distance to the wall: positive inside the fluid
    ipd = vtk.vtkImplicitPolyDataDistance(); ipd.SetInput(surf)
    pts = np.asarray(img.points)
    vtk_pts = vtk.vtkPoints(); vtk_pts.SetData(vtk.util.numpy_support.numpy_to_vtk(pts, deep=True))
    out_scalars = vtk.vtkDoubleArray()
    ipd.FunctionValue(vtk_pts.GetData(), out_scalars)
    d = np.abs(vtk.util.numpy_support.vtk_to_numpy(out_scalars))
    sdf = np.where(valid, d, -d)
    sdf_q = np.clip(np.round(sdf / h * 32), -127, 127).astype(np.int8)   # resolution h/32, range +-4h
    active = sdf_q > -64      # same test the web page uses to rebuild the active-voxel index
    print(f"[{name}] inside {valid.sum()} active {active.sum()} ({time.time()-t0:.0f}s)")

    shape = tuple(dims[::-1])  # (nz, ny, nx); VTK point order is x fastest
    # fill values outside the fluid with the nearest fluid value so interpolation near the wall is smooth
    _, idx = ndimage.distance_transform_edt(~valid.reshape(shape), return_indices=True)
    nearest = np.ravel_multi_index(idx, shape).ravel()

    grid_meta = dict(dims=dims.tolist(), origin=lo.tolist(), h=h, nactive=int(active.sum()), channels=[])
    blobs = [sdf_q.tobytes()]
    vel = np.asarray(sampled["velocity"])
    vel[~valid] = 0.0
    for comp in range(3):
        v = vel[active, comp]
        s = max(np.abs(v).max(), 1e-9) / 32767
        blobs.append(np.round(v / s).astype(np.int16).tobytes())
        grid_meta["channels"].append(dict(name=f"velocity{comp}", type="int16", scale=float(s), offset=0.0))
    for arr in ["pressure", "average_pressure", "average_speed"]:
        a = np.asarray(sampled[arr]).copy()
        if arr == "average_speed":
            a[~valid] = 0.0
        else:
            a = a[nearest]
        a = a[active]
        q, qlo, qhi = quantise(a)
        blobs.append(q.tobytes())
        span = (qhi[0] - qlo[0]) or 1.0
        grid_meta["channels"].append(dict(name=arr, type="uint16", scale=span / 65535, offset=qlo[0]))
    with gzip.open(os.path.join(out, name, "grid.bin.gz"), "wb", compresslevel=9) as f:
        for bb in blobs:
            f.write(bb)

    # plane through the arch (smallest-variance direction of the wall points) for the clip helper
    P = pos.astype(np.float64); c = P.mean(0)
    _, _, vt = np.linalg.svd(P - c, full_matrices=False)
    meta = dict(name=name, file=f"{name}.vtu", npoints=int(mesh.n_points), ncells=int(mesh.n_cells),
                bounds=np.array(mesh.bounds).tolist(), arrays=info_arrays, surface=surf_meta,
                grid=grid_meta, caps=caps, arch_plane=dict(origin=c.round(5).tolist(), normal=vt[2].round(5).tolist()))
    with open(os.path.join(out, name, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    for fn in ["surface.bin.gz", "grid.bin.gz"]:
        print(f"[{name}] {fn}: {os.path.getsize(os.path.join(out, name, fn))/1e6:.2f} MB")
    print(f"[{name}] caps:", [(c['role'], c['radius']) for c in caps], f"done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    import vtk.util.numpy_support  # noqa: F401
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--out", default="data")
    ap.add_argument("--h", type=float, default=0.025, help="grid spacing in cm")
    args = ap.parse_args()
    for p in args.files:
        process(p, os.path.splitext(os.path.basename(p))[0], args.out, args.h)
