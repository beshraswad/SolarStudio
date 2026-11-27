"""Reusable landscape figures from annual and hourly SolarStudio results."""
import calendar
from io import BytesIO

import numpy as np
import pandas as pd
from matplotlib.figure import Figure
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

from study import areas

INK, BG = "#10283e", "#f3f6f9"
ROOF, WALL, OPEN = "#076d81", "#7595b0", "#cfdee8"
BEAM, OTHER = "#e98939", "#8a69a4"
TITLES = ["Annual exposure by face","Roof exposure and shading","Where annual losses occur",
          "Selected surfaces through the year","Hourly and seasonal patch exposure"]
FIGURES = ["Exposure per square metre","Exposure across the full face",
           "Annual roof irradiation","Roof loss relative to open","Annual losses by face",
           "Area by exposure level","Monthly energy across the selection","Average day across the selection",
           "Monthly irradiation by component","Hourly irradiation calendar"]


def annual_frame(model, result, north):
    tri=np.asarray(model["patches"])
    centroid=tri.mean(axis=1)
    normal=np.asarray(model["normals"])
    az=(np.degrees(np.arctan2(normal[:,0],normal[:,1]))-north)%360
    az[np.linalg.norm(normal[:,:2],axis=1)<1e-7]=np.nan
    return pd.DataFrame(dict(patch_id=np.arange(len(tri))+1,face_id=np.asarray(model["faces"])+1,
        surface=model["types"],area_m2=areas(tri),centroid_x_model_m=centroid[:,0],
        centroid_y_model_m=centroid[:,1],azimuth_deg_true=az,annual_poa_kwh_m2=result["total"],
        open_poa_kwh_m2=result.get("open"),beam_loss_kwh_m2=result.get("loss")))


def selected_frame(profile):
    if not profile:
        return None
    tables=[]
    for face in profile["faces"]:
        for key, label in (("series","with obstructions"),("baseline","targets only")):
            if key in face:
                v=np.array(face[key])
                tables.append(pd.DataFrame(dict(face_id=face["id"],timestamp_midpoint=profile["timestamps"],
                    scenario=label,incident_kWh_per_hour=v[3]*face["area"] / 1000)))
    return pd.concat(tables,ignore_index=True) if tables else None


def patch_frame(scene, config, index, face):
    rows=scene.hourly(config,index)
    cols="utc_midpoint ghi dni dhi elevation zenith azimuth incidence direct_sun beam_wh_m2 sky_wh_m2 ground_wh_m2 poa_wh_m2 beam_loss_wh_m2 open".split()
    frame=pd.DataFrame(rows,columns=cols)
    return frame.assign(patch_id=index+1,face_id=face)


def face_table(annual):
    p=annual.copy()
    p["modeled"]=p.area_m2*p.annual_poa_kwh_m2
    p["open"]=p.area_m2*p.open_poa_kwh_m2 if "open_poa_kwh_m2" in p else np.nan
    p["beam"]=p.area_m2*p.beam_loss_kwh_m2 if "beam_loss_kwh_m2" in p else np.nan
    grouped=p.groupby(["face_id","surface"],sort=False)
    v=grouped[["area_m2","modeled","open","beam"]].sum(min_count=1)
    v["azimuth"]=grouped.azimuth_deg_true.first()
    v["mean"]=v.modeled/v.area_m2
    denominator=v.open.where(v.open>0)
    v["loss"]=100*(v.open-v.modeled)/denominator
    v["beamLoss"]=100*v.beam/denominator
    v["remaining"]=v.loss-v.beamLoss
    return v.reset_index()


def label(f):
    direction="flat" if pd.isna(f.azimuth) else ("N","NE","E","SE","S","SW","W","NW")[int((f.azimuth+22.5)//45)%8]
    return f"{f.face_id} · {f.surface} {direction}"


def plot_figure(index, drawing, context):
    fig=Figure(figsize=(6.4,5.25),facecolor=BG)
    ax=fig.add_subplot()
    ax.set_title(FIGURES[index],fontsize=13,color=INK,fontweight="bold",pad=11)
    ax.set_facecolor("#fbfcfd")
    ax.grid(color="#e4e9ed",linewidth=.6)
    ax.set_axisbelow(True)
    ax.tick_params(labelsize=8)
    for side in ("top","right"):
        ax.spines[side].set_visible(False)
    note=drawing(fig,ax)
    fig.tight_layout(pad=1.4,rect=(0,.075,1,.95))
    fig.text(.03,.964,context,color=INK,fontsize=8)
    fig.text(.03,.022,note,color=INK,fontsize=8,wrap=True)
    out=BytesIO()
    fig.savefig(out,format="png",dpi=180,facecolor=BG)
    return out.getvalue()


def unavailable(ax,message):
    ax.set_axis_off()
    ax.text(.5,.5,message,ha="center",va="center",color=INK,wrap=True,transform=ax.transAxes)
    return ""


def months(ax):
    ax.set_xticks(range(1,13),calendar.month_abbr[1:],fontsize=8)
    ax.set_xlim(.35,12.65)


def generate(project, config, tz, annual=None, selected=None, patch=None, unavailable_reasons=None):
    issues=unavailable_reasons or {}
    have_annual=annual is not None and len(annual)>0
    faces=face_table(annual) if have_annual else None
    roof=annual[annual.surface=="roof"].copy() if have_annual else None
    selection_note=""
    series={}
    if selected is not None and len(selected):
        s=selected.copy()
        s["time"]=pd.to_datetime(s.timestamp_midpoint,utc=True).dt.tz_convert(tz)
        s=s.drop_duplicates(["scenario","face_id","time"])
        series={str(k):v.groupby("time").incident_kWh_per_hour.sum()
                for k,v in s.groupby("scenario",sort=False)}
        lines=list(series.values())
        identical=len(lines)>1 and all(lines[0].index.equals(v.index) and np.allclose(lines[0],v,rtol=0,atol=1e-8) for v in lines[1:])
        if identical:
            selection_note="Exported hourly scenarios are identical for this selection."
            series={next(iter(series)):lines[0]}
    if patch is not None and len(patch):
        patch=patch.copy()
        patch["time"]=pd.to_datetime(patch.utc_midpoint,utc=True).dt.tz_convert(tz)
        patch=patch.drop_duplicates("time").sort_values("time")
    else:
        patch=None

    def draw(i, fig, ax):
        if i<6 and not have_annual:
            return unavailable(ax,issues.get("annual","Run annual analysis for the active model to populate this figure."))
        if i in (0,1,4):
            x={0:"mean",1:"modeled",4:"loss"}[i]
            f=faces.sort_values(x,ascending=False,na_position="last")
            y=np.arange(len(f))
            colors=np.where(f.surface=="roof",ROOF,WALL)
            if i==0:
                ax.barh(y,f.open/f.area_m2,color=OPEN,label="Open reference")
                ax.barh(y,f["mean"],color=colors)
                if f.open.notna().any(): ax.legend(loc="lower right",fontsize=8)
            elif i==1:
                ax.barh(y,f.modeled/1000,color=colors)
            else:
                if not (f.open.gt(0)&f.beam.notna()).any():
                    return unavailable(ax,"Open-reference and beam loss values are required.")
                ax.barh(y,f.beamLoss,color=BEAM,label="Beam")
                ax.barh(y,f.remaining,left=f.beamLoss,color=OTHER,label="Remaining loss")
                for j,value in enumerate(f.loss):
                    if pd.isna(value): ax.text(0,j,"Unavailable",va="center",fontsize=8)
                ax.legend(loc="lower right",fontsize=8)
            ax.set_yticks(y,[label(row) for row in f.itertuples()],fontsize=max(4,8-len(f)//26))
            ax.invert_yaxis()
            ax.set_xlabel({0:"Area-weighted irradiation (kWh/m²)",1:"Incident solar energy (MWh)",
                           4:"Loss relative to open reference (%)"}[i])
            return ["Teal: roofs. Blue-grey: walls. Pale bars: annual open reference.",
                    "Incident energy sums patch area × irradiation.",
                    "Remaining loss = open − modeled − beam loss."][{0:0,1:1,4:2}[i]]
        if i in (2,3):
            if roof.empty:
                return unavailable(ax,"No roof patches in the annual result.")
            z=roof.annual_poa_kwh_m2
            if i==3:
                if "open_poa_kwh_m2" not in roof:
                    return unavailable(ax,"Annual open-reference values are required.")
                reference=roof.open_poa_kwh_m2.where(roof.open_poa_kwh_m2>0)
                z=100*(reference-roof.annual_poa_kwh_m2)/reference
                if not z.notna().any():
                    return unavailable(ax,"No positive open-reference values.")
            if z.isna().any():
                missing=roof[z.isna()]
                ax.scatter(missing.centroid_x_model_m,missing.centroid_y_model_m,s=7,c="#b4bec7")
            points=ax.scatter(roof.centroid_x_model_m,roof.centroid_y_model_m,c=z,s=7,
                             cmap="viridis" if i==2 else "magma",vmin=0 if i==3 else None,linewidths=0)
            fig.colorbar(points,ax=ax,shrink=.85,label="kWh/m²" if i==2 else "% loss")
            for face,g in roof.groupby("face_id"):
                ax.text(np.average(g.centroid_x_model_m,weights=g.area_m2),np.average(g.centroid_y_model_m,weights=g.area_m2),
                        str(face),ha="center",va="center",fontsize=7,bbox=dict(facecolor="white",alpha=.83,edgecolor="none",pad=1))
            ax.set_aspect("equal")
            ax.set(xlabel="Model X (m)",ylabel="Model Y (m)")
            return "Sampled patch centroids. Grey indicates unavailable reference." if i==3 else "Patch centroids at model coordinates. Labels are roof face IDs."
        if i==5:
            maximum=max(100,100*np.ceil(annual.annual_poa_kwh_m2.max()/100))
            bins=np.arange(0,maximum+100,100)
            for kind,color in (("roof",ROOF),("wall",WALL)):
                g=annual[annual.surface==kind]
                if len(g):
                    ax.hist(g.annual_poa_kwh_m2,bins=bins,weights=g.area_m2,histtype="step",
                            linewidth=1.6,label=kind.title(),color=color)
            ax.legend(fontsize=8)
            ax.set(xlabel="Annual irradiation (kWh/m²)",ylabel="Area per bin (m²)")
            return "Area-weighted, shared 100 kWh/m² bins."
        if i in (6,7):
            if not series:
                return unavailable(ax,issues.get("selected","Select at least one matched study face to populate the hourly profiles."))
            if i==6:
                name,v=next(iter(series.items()))
                sums=v.groupby(v.index.month).sum()/1000
                ax.bar(sums.index,sums,color=ROOF)
                months(ax)
                ax.set_ylabel("Incident solar energy (MWh)")
                return f"Total {v.sum()/1000:,.2f} MWh · {name} · local months"
            for j,(name,v) in enumerate(series.items()):
                hours=v.index.hour+v.index.minute/60
                values=v.groupby(hours).mean()
                ax.plot(values.index,values,color=(ROOF,WALL)[j%2],linewidth=1.8,
                        linestyle="-" if j==0 else "--",label=name.title())
                if j==0: ax.fill_between(values.index,0,values,color=ROOF,alpha=.15)
            ax.legend(fontsize=8)
            ax.set(xlabel="Local hour (midpoint)",ylabel="Mean incident energy per hour (kWh)",xlim=(0,24))
            ax.set_xticks(range(0,25,3))
            return selection_note or "Faces are summed by timestamp before averaging."
        if patch is None:
            return unavailable(ax,issues.get("patch","Select a patch on the 3D model to populate this figure."))
        patch_id=int(patch.patch_id.iloc[0])
        if i==8:
            sums=patch.groupby(patch.time.dt.month)[["beam_wh_m2","sky_wh_m2","ground_wh_m2"]].sum()/1000
            bottom=np.zeros(len(sums))
            for col,color,name in zip(sums,[ROOF,BEAM,OTHER],["Beam","Sky diffuse","Ground reflected"]):
                ax.bar(sums.index,sums[col],bottom=bottom,color=color,label=name)
                bottom+=sums[col].to_numpy()
            months(ax)
            ax.set_ylabel("Irradiation (kWh/m²)")
            ax.legend(fontsize=7,ncol=3,loc="upper center")
            return f"Patch {patch_id} · Face {int(patch.face_id.iloc[0])} · local months"
        dates=patch.time.dt.date
        year=config["year"]
        bounds=pd.to_datetime([f"{year}-01-01T00:30Z",f"{year+1}-01-01T00:30Z"],utc=True).tz_convert(tz)
        days=pd.date_range(bounds[0].date(),(bounds[1]-pd.Timedelta(hours=1)).date(),freq="D")
        ids=pd.Index(days.date).get_indexer(dates)
        heat=np.full((24,len(days)),np.nan)
        valid=ids>=0
        heat[patch.time.dt.hour.to_numpy()[valid],ids[valid]]=patch.poa_wh_m2.to_numpy()[valid]
        palette=__import__("matplotlib").colormaps["viridis"].with_extremes(bad="#aebbc7")
        img=ax.imshow(heat,extent=(0,len(days),0,24),origin="lower",aspect="auto",cmap=palette,vmin=0,
                      interpolation="nearest")
        ticks=[(j,calendar.month_abbr[d.month]) for j,d in enumerate(days) if d.day==1 and d.year==year]
        ax.set_xticks([j for j,_ in ticks],[label for _,label in ticks],fontsize=8)
        ax.set_yticks(range(0,25,3))
        ax.set(xlabel="Local date",ylabel="Local hour")
        fig.colorbar(img,ax=ax,shrink=.84,label="Wh/m² per hour")
        peak=patch.loc[patch.poa_wh_m2.idxmax()]
        return (f"Patch {patch_id} · {patch.poa_wh_m2.sum()/1000:,.2f} kWh/m² · "
                f"{patch.direct_sun.sum():,.0f} direct-sun h · {patch.beam_loss_wh_m2.sum()/1000:,.2f} kWh/m² beam loss\n"
                f"Peak {peak.poa_wh_m2:,.2f} Wh/m² at {peak.time:%d %b %H:%M} local · Grey marks absent hours.")

    context=f"{project[:55]} / {config['year']} UTC / UTC{tz.tzname(None).removeprefix('UTC')}"
    pngs=[plot_figure(i,lambda fig,ax,i=i:draw(i,fig,ax),context) for i in range(10)]
    pdf_bytes=BytesIO()
    pdf=Canvas(pdf_bytes,pagesize=(864,468))
    pdf.setTitle(project+" - Solar analysis")
    period=f"{config['year']} UTC weather year"
    meta=f"{period} / {config['lat']}, {config['lon']} / north {config['north']:.1f} deg / UTC{tz.tzname(None).removeprefix('UTC')} / NASA POWER"
    for i,title in enumerate(TITLES):
        pdf.setFillColor(HexColor(BG));pdf.rect(0,0,864,468,fill=1,stroke=0)
        pdf.setFillColor(HexColor(INK));pdf.setFont("Helvetica-Bold",26)
        pdf.drawString(33,431,title)
        pdf.setFont("Helvetica",11)
        pdf.drawString(33,410,project[:85]+" / "+meta)
        detail=""
        if i==3 and selected is not None: detail="Selected faces: "+", ".join(map(str,selected.face_id.unique()))
        if i==4 and patch is not None: detail=f"Patch {int(patch.patch_id.iloc[0])} / Face {int(patch.face_id.iloc[0])}"
        if detail: pdf.drawString(33,393,detail)
        for j in range(2):
            pdf.drawImage(ImageReader(BytesIO(pngs[i*2+j])),27+j*411,31,width=399,height=345,
                          preserveAspectRatio=True,anchor="c")
        pdf.setFont("Helvetica",8);pdf.drawRightString(831,22,f"{i+1:02d}")
        pdf.showPage()
    pdf.save()
    return pdf_bytes.getvalue(),pngs

