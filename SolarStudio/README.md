# Solar Studio

A desktop-first local web app for geometry-based solar irradiation. It opens the supplied Abu Dhabi villa with results from the bundled 2024 NASA POWER weather record.

## Run on Windows

From this folder in PowerShell, using 64-bit Python 3.12:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

If Python is installed without the Windows launcher, use `python -m venv .venv` for the first command.

Open [Solar Studio](http://127.0.0.1:8765/) in a browser with WebGL. Keep the server terminal open. Stop it with Ctrl+C. The villa opens offline after setup. A new site or year requires an internet connection on the first run.

## Use the workspace

1. Open the villa or import a Z-up `.step` or `.stp` model. Include shade-casting surroundings in the same file.
2. Enter latitude, longitude and a completed weather year. Click the viewport compass to preview a rotation on the ground and apply it. Expand **Align from a reference** for the north-arrow and roof-edge methods.
3. Click **Run annual analysis**. Use **Roofs**, **Walls** or **All** to recolor the model on the same scale. Click a patch to see its annual components, tilt and true azimuth. Flat faces have no azimuth.
4. Enter a date, local time and UTC offset, then click **Show full day path**. The gold arc shows daylight, the dashed arc continues below the horizon, and the marker shows the sun at the chosen time. The model shows estimated instantaneous clear-sky irradiance on a shared 0–1,200 W/m² scale.
5. **Play day** animates the selected date from midnight to midnight. **Play year** plays one average solar day per month, January through December, for the weather year in Project setup. Pause, scrub through local time, choose a month, or change playback speed. You can orbit the model during either playback.
6. Use **Annual** for design comparisons in kWh/m². The year player returns to that map when matching annual results exist. Pick a patch and toggle **Face detail** to see subtle differences on a single face with a tighter, labeled range. Compare different faces using the shared annual scale.
7. Open the **Solar Studio** logo menu for **Calculations**, **Annual patches CSV**, or **Selected patch hourly CSV**. Calculations shows the selected patch, a worked NASA POWER hour from the date and time controls, and the annual component sum. The annual export contains one row per patch. The hourly export traces one patch against every UTC weather interval.
8. Click **Place Panels** and click the planar roof faces to include. Set module dimensions and power, then use **Draw exclusion** to click a polygon on one selected surface. Close the polygon, or edit it later by selecting a vertex and clicking its new location. **Preview layout** shows candidate modules and the annual estimate. **Apply layout** keeps the selected preview on the current model.
9. Open **Results Summary** for internal run checks, roof faces ranked by area-weighted annual irradiation, the largest annual shading loss per square metre, and the selected patch’s beam, diffuse and ground-reflection losses. Click a finding to focus the corresponding face or patch. **Show calculation** expands the arithmetic. The summary uses local deterministic rules and has a separate benchmark section.

Panel previews focus the camera on the layout automatically. Use **Focus panels** to return to that framing after orbiting or panning. Light module frames outline the dark panel footprints.

With no load, the planner fills usable area. With a load you can choose **Size to target**. This uses the highest-yield modules from the best screened grid and reports the remaining annual shortfall if the full grid falls short. The search tries both flush-mounted rotations and nine grid offsets per orientation. Setback defaults to 0.30 m, module spacing to 0.10 m and performance ratio to 0.80. Boundaries, exclusions and module footprints are checked in each roof plane. The planner also avoids overlapping footprints in plan across selected faces.

Module irradiation is the area-weighted annual irradiation of the intersected roof patches. Estimated annual generation is module kWp multiplied by plane-of-array annual irradiation and the performance ratio. This is a screening estimate based on flush-mounted modules. Electrical design, load matching by hour, and detailed equipment or mounting-system shading require separate analysis. The applied layout is kept while the workspace remains open.

## Same-pitch verification

The default run uses 24.4539° N, 54.3773° E and model +Y as true north. On CAD face **15**, both points have **25° tilt** and **180° true azimuth**.

| Patch | Centroid X, Y, Z (m) | Annual (kWh/m²) | Beam lost to shade (kWh/m²) |
|---|---|---:|---:|
| Shaded 6743 | −3.149, 6.123, 6.557 | 1,902.12 | 9.95 |
| Clear 6382 | −2.798, 12.877, 9.707 | 1,950.30 | 0.00 |

The clear patch receives **48.18 kWh/m² more**. The two patches share identical orientation and open-reference irradiation. Their actual totals differ because geometry blocks some direct sun and changes the visible sky and ground. Use the two buttons below the annual legend to inspect the comparison.

Recompute and check the comparison using the supplied STEP and raw weather cache:

```powershell
.\.venv\Scripts\python.exe verify_villa.py
```

## Surface studies

Click a roof or wall in the viewport to select its CAD face. Click more faces to add them and click a selected face again to remove it. You can also use **Pick by face ID** or **Clear selection**. Face IDs are stable within an imported STEP model and across its scenario variants. Choose a selected local date or the full UTC weather year for summaries. The chart always uses the selected local date. Daily data use the configured fixed UTC offset and available weather intervals. At the ends of a UTC weather year, a local day may have fewer than 24 intervals.

**Hourly CSV** exports the reporting period, including weather and orientation metadata, local midpoint timestamps, irradiance components in W/m², and area-integrated hourly energy in kWh. The **PDF report** includes the current 3D view with selected-face IDs, a daily profile, per-face results, and source settings. Direct sun hours are area-weighted equivalent hours of unobstructed front-facing daylight. Peak power is the peak hourly face average, not the peak at any individual patch. For nonplanar CAD faces, tilt and azimuth summarize the area-weighted normal.

**Compare shading** compares target solids alone with the same model including its obstructions. Use the solid role checkboxes or pick objects in 3D. Both variants use the same receiver patches, weather, camera, date and orientation. The before and after maps share a scale; the difference map uses a signed scale. The comparison maps show selected face averages. A face outside the chosen targets is flagged as unmatched. Matching applies within a STEP import; separate STEP files with edited geometry are not automatically reconciled. Obstruction attribution reports the first non-target triangle hit for unobstructed-plane daylight rays at the chosen instant.

In **Inspect surfaces**, enable **Include absorbed heat** for any selected faces and enter a shared absorptivity. Absorbed heat uses `absorptivity × irradiance × face area` in watts. The chart can show per-face irradiance or absorbed heat, and the CSV includes hourly absorbed watts. The solver includes shading from the imported geometry. Click a different viewer tool to leave playback or exit a picking mode. Escape closes the active viewport tool.

Run `python verify_study.py` for the unobstructed 900 W/m² reference, an overhead-blocker test (0 vs 800 W/m² direct beam), a 2-to-32-sample mesh check, hourly CSV reconciliation and absorbed-heat consistency. With `--neighborhood PATH`, the check imports the supplied neighborhood file and verifies that Face 6 loses about 213.09 kWh/m² annually, Object 2 intercepts direct sun on about 12.81% of Face 6 at 10:30 Abu Dhabi time on 20 March 2024, and invalid face IDs are flagged. Run `python validate_shading.py` for the separate villa sensitivity study.

The source code and documentation use the MIT license. Bundled third-party libraries retain their own notices. Supplied CAD and image assets and weather data retain their respective rights and terms.

## Local result provenance

### Annual figures

Run annual analysis, select the faces for the hourly profile in Surface study, and click a patch in the viewport for the detailed charts. Open **Annual figures** to preview ten charts, download each PNG, or export the five-page landscape report. The report uses the configured UTC weather year and the current display timezone. Optional shading comparison follows the Surface study setting. Missing data is marked on the affected charts. The app currently imports STEP geometry. The separate `verify_figure_report.py` command checks and renders the known villa CSV exports, including deduplication of identical annual CSV copies.

The panel planner sends the analysis ID and configuration to the server. Layout estimates and worked calculations use the completed result associated with that ID, checked against the model, coordinates, year and north bearing. The local server bounds analysis history and concurrent queued work. Before hosting, add authenticated workspace ownership, isolated STEP parsing with resource limits, and model and weather-cache limits.

## Shading sensitivity

Run `python validate_shading.py` after installing the requirements. The default check compares the baseline with 15-minute sun samples, 1,024 directions per hemisphere and four child patches per flat connecting roof patch. Options are available via `--help`. Sub-hour samples divide each NASA POWER interval's energy evenly among its substeps. The study keeps all imported triangles in the occlusion scene. Only the flat roof is spatially refined.

For the bundled 2024 run, the baseline and combined refinement gave flat-roof area averages of 1,145.61 and 1,139.68 kWh/m². The peak local loss moved from 63.21% to 66.88% and shifted position. South remained above west, changing from 1,947.54 versus 1,788.05 kWh/m² to 1,943.91 versus 1,786.53 kWh/m². Independent triangle-intersection math agreed with the production ray tracer at three sampled times on the baseline hotspot. This is an internal sensitivity and geometry check. An independent benchmark or measured validation remains open.

## Modeling assumptions

- Open CASCADE tessellates STEP B-rep faces using a 25 mm linear tolerance and converts geometry to metres. The model is centered horizontally with its lowest point at Z=0. Outward normals with Z component above 0.25 are classified as roof. Normals from −0.12 to 0.25 are classified as wall. Curved faces use local triangle normals. Patches are subdivided triangles. The villa is a simplified solid measuring 33 × 40 × 9.764 m.
- North alignment rotates the model’s frame relative to geographic north. Tilt is measured from horizontal and azimuth is clockwise from true north. The initial villa alignment assumes +Y is north, pending confirmation from a known bearing or site reference.
- The [NASA POWER Hourly Point API](https://power.larc.nasa.gov/docs/services/api/temporal/hourly/) supplies all-sky GHI, DNI and DHI. The raw UTC response is validated and cached by coordinates rounded to four decimals and weather year. A complete year has 8,760 records, or 8,784 in a leap year. An incomplete response stops the run.
- pvlib evaluates apparent solar elevation and azimuth at each hourly interval midpoint. For each front-facing patch, Embree traces a ray from its centroid with a 0.2 mm outward offset against all imported triangles. A hit removes the hour’s direct beam at that patch. Small shade boundaries are limited by mesh resolution and hourly sampling.
- Annual irradiation sums projected, unoccluded DNI, isotropic sky diffuse and ground reflection using an albedo of 0.2. For diffuse and ground, 256 directions per hemisphere estimate cosine-weighted visibility. The result scales the corresponding analytical open factor. Opaque objects block rays and ground reflection is modeled as uniform Lambertian radiance. Façade interreflection is outside this model.
- Preview uses the entered UTC offset. Playback ray traces shadows at 15-minute local-clock intervals and interpolates the marker between samples. For each month, at each clock time, pvlib sun vectors from every date in the month are averaged and normalized. The average vector drives the marker and ray tracing for that frame. This is a solar geometry average. The same fixed UTC offset applies across all months, and weather is used for the annual irradiation analysis.
- The live contour uses pvlib’s Ineichen clear-sky model at sea level with fixed Linke turbidity of 3. Both maps interpolate patch values within CAD faces and display 16 contour bands. The patch inspector reports the underlying sample. The annual NASA POWER result is the design baseline.
- The local server retains imported geometry and jobs in memory until restart. Uploads support up to 25 MB, 25,000 tessellated triangles and 24,000 analysis patches. Panel placement supports planar faces and uses screening-level generation estimates.

The proposal’s dashboard informed the three-column layout. The review slides informed the beam, isotropic diffuse and ground-reflection terms. The preview and inspector use north-referenced azimuth throughout.

