"""PDF and CSV rendering for face studies."""
import base64
import binascii
import csv
from io import BytesIO, StringIO

from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas


def hourly_csv(profile, project):
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(["face_id","object_id","timestamp_midpoint","utc_offset","scenario",
                     "beam_W_m2","diffuse_W_m2","ground_W_m2","total_W_m2","sunlit_area_fraction",
                     "incident_kWh_per_hour","area_m2","latitude_deg","longitude_deg",
                     "north_clockwise_from_model_Y_deg","weather_year_UTC","weather_source",
                     "period_first_midpoint","period_last_midpoint","project","absorptivity","absorbed_W"])
    s = profile["settings"]
    project = "'"+project if project.startswith(("=","+","-","@","\t","\r")) else project
    for f in profile["faces"]:
        for label,key in (("with obstructions","series"),("targets only","baseline")):
            if key not in f:
                continue
            for stamp, row in zip(profile["timestamps"],zip(*f[key])):
                writer.writerow([f["id"],f["object"],stamp,profile["timezone"],label,
                                 *[round(v,8) for v in row],round(row[3]*f["area"]/1000,8),
                                 f["area"],s["lat"],s["lon"],s["north"],s["year"],profile["source"],
                                 profile["first"],profile["last"],project,profile["absorptivity"],
                                 round(row[3]*f["area"]*profile["absorptivity"],8)
                                 if profile["absorptivity"] is not None else None])
    return output.getvalue()


def report(profile, project, snapshot):
    if not profile["faces"]:
        raise ValueError("Select a target face to export.")
    if not str(snapshot).startswith("data:image/png;base64,") or len(snapshot)>8_000_000:
        raise ValueError("A 3D snapshot is required.")
    try:
        image = ImageReader(BytesIO(base64.b64decode(snapshot.split(",",1)[1],validate=True)))
        iw, ih = image.getSize()
    except (ValueError, OSError, binascii.Error) as error:
        raise ValueError("Could not read the 3D snapshot.") from error
    out = BytesIO()
    pdf = Canvas(out,pagesize=(595,842))
    pdf.setTitle("Solar Studio - Selected Surfaces")
    pdf.setFont("Helvetica-Bold",20)
    pdf.drawString(36,800,"Selected surfaces")
    pdf.setFont("Helvetica",10)
    pdf.drawString(36,780,project[:90])
    s = profile["settings"]
    lines = [
        f"Site {s['lat']}, {s['lon']}   |   True north {s['north']:.2f} deg clockwise from model +Y",
        f"{profile['source']}   |   Weather year {s['year']} UTC   |   Display UTC{profile['timezone']}",
        f"Period (hour midpoints): {profile['first']} to {profile['last']}",
        f"Area weighted: {profile['mean']:.2f} kWh/m2   |   Incident energy: {profile['incident']:.2f} kWh",
    ]
    for i,line in enumerate(lines):
        pdf.drawString(36,762-i*15,line)
    ratio = min(523/iw,225/ih)
    pdf.drawImage(image,(595-iw*ratio)/2,470,width=iw*ratio,height=ih*ratio,mask="auto")
    ids = ", ".join(str(f["id"]) for f in profile["faces"])
    pdf.drawString(36,452,"3D view   |   Selected face IDs: "+ids)
    w,h,x,y = 495,113,59,306
    pdf.setStrokeColor(HexColor("#879da4"))
    pdf.line(x,y,x+w,y)
    pdf.line(x,y,x,y+h)
    faces = profile["faces"]
    samples = profile["timestamps"]
    peak = max(1,*(max(f[key][3],default=0) for f in faces
                   for key in ("series","baseline") if key in f))
    colors = ["#075945","#365dcc","#bd4829","#7e3988","#785b00","#087285",
              "#b92b62","#4f6480","#25723d","#7047bd","#955724","#2764a5"]
    for i,f in enumerate(faces):
        pdf.setStrokeColor(HexColor(colors[i%len(colors)]))
        for key in ("series","baseline"):
            if key not in f:
                continue
            pdf.setDash(4,3) if key=="baseline" else pdf.setDash()
            values = f[key][3]
            path = pdf.beginPath()
            for j,value in enumerate(values):
                point=(x+j*w/max(1,len(samples)-1),y+h*value/peak)
                if j:
                    path.lineTo(*point)
                else:
                    path.moveTo(*point)
            pdf.drawPath(path)
    pdf.setDash()
    pdf.setFont("Helvetica",9)
    if samples:
        pdf.drawString(36,428,"Hourly face irradiance (W/m2)   |   "+samples[0][:10]+" local")
        pdf.drawString(36,405,f"{peak:.0f}")
        pdf.drawString(x,293,samples[0][11:16])
        pdf.drawRightString(x+w,293,samples[-1][11:16])
    columns = (38,77,135,173,230,277,345,469)
    pdf.setFont("Helvetica-Bold",8)
    for column,label in zip(columns,("Face","Area (m2)","Tilt","True az.","Sun h",
                                    "Peak (W/m2)","Peak local time","kWh/m2")):
        pdf.drawString(column,270,label)
    pdf.setFont("Helvetica",8)
    for i,f in enumerate(faces):
        row_y=253-i*15
        pdf.setFillColor(HexColor(colors[i%len(colors)]))
        pdf.circle(32,row_y+3,2,fill=1,stroke=0)
        pdf.setFillColor(HexColor("#172831"))
        az="Flat" if f["azimuth"] is None else f"{f['azimuth']:.1f}"
        cells=[f["id"],f"{f['area']:.1f}",f"{f['tilt']:.1f}",az,f"{f['hours']:.2f}",
               f"{f['peak']:.1f}",f["peakTime"][:16].replace("T"," "),f"{f['energy']:.2f}"]
        for column,value in zip(columns,cells):
            pdf.drawString(column,row_y,str(value))
    if any("baseline" in f for f in faces):
        pdf.drawString(36,62,"Dashed profiles use target solids alone. The table uses the full obstruction scene.")
    if profile["absorptivity"] is not None:
        pdf.drawString(36,62,f"Selected surfaces absorb {profile['absorbed']:.2f} kWh at absorptivity {profile['absorptivity']:.2f}.")
    pdf.drawString(36,48,"Direct sun hours are area-weighted and count unobstructed front-facing daylight.")
    pdf.drawString(36,35,"The study uses hourly weather and geometry-based direct, diffuse and ground shading.")
    pdf.save()
    return out.getvalue()

