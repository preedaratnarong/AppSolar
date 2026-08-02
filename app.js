(() => {
  "use strict";

  const APP_KEY = "nexoraSolarPlanner.v1";
  const THAI_MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
  const STANDARD_INVERTERS = [3,5,6,8,10,12,15,20,25,30,40,50,60,80,100];
  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const number = (id, fallback = 0) => Number($(id)?.value) || fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const round = (value, digits = 1) => Number(value.toFixed(digits));
  const fmt = (value, digits = 0) => Number(value || 0).toLocaleString("th-TH", {maximumFractionDigits: digits, minimumFractionDigits: digits});
  const uid = () => `prj-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const defaultInputs = {
    monthlyBill: 4500, monthlyEnergy: 1000, peakLoad: 7.5, tariff: 4.18,
    panelWatt: 550, sunHours: 4.7, systemLoss: 20, shadeLoss: 8,
    backupHours: 12, batteryDod: 90, batteryVoltage: 51.2, inverterMargin: 25,
    latitude: 13.4167, longitude: 101.3347, roofAzimuth: 180, roofTilt: 12
  };
  const seedProject = {
    id: uid(), name: "บ้านคุณณรงค์ - ชลบุรี", location: "อำเภอเกาะจันทร์, ชลบุรี",
    mode: "hybrid", phase: "3", inputs: {...defaultInputs}, result: null,
    updatedAt: new Date().toISOString(), surveys: []
  };
  const defaultState = {
    projects: [seedProject], activeProjectId: seedProject.id,
    equipment: {panelModel:"N-Type Mono 550W", panelWatt:550, panelArea:2.65, batteryModel:"Rack Battery 51.2V", batteryModule:5.12, batteryDod:90, inverterModel:"3-Phase Hybrid", inverterEfficiency:96.5, dcAcRatio:1.15},
    settings: {fontScale:"1.1", highContrast:false, defaultLocation:"ชลบุรี, ประเทศไทย", defaultSunHours:4.7, background:{dataUrl:"bg.png",opacity:18,blur:0,position:"center center",size:"cover"}}
  };

  let state = loadState();
  let currentResult = null;
  let cameraStream = null;
  let animationFrame = null;
  let deviceHeading = null;
  let deferredInstall = null;
  let toastTimer = null;
  
  let mapInstance = null;
  let mapDrawLayer = null;
  let mapPolyPoints = [];
  let mapPolygon = null;

  function loadState(){
    try {
      const saved = JSON.parse(localStorage.getItem(APP_KEY));
      if (!saved?.projects?.length) return clone(defaultState);
      if (saved.settings && saved.settings.background && saved.settings.background.dataUrl === null && !saved.settings.background.cleared) {
        saved.settings.background.dataUrl = "bg.png";
      }
      return {...clone(defaultState), ...saved, equipment:{...defaultState.equipment,...saved.equipment}, settings:{...defaultState.settings,...saved.settings,background:{...defaultState.settings.background,...(saved.settings?.background||{})}}};
    } catch { return clone(defaultState); }
  }
  function persist(){ try { localStorage.setItem(APP_KEY, JSON.stringify(state)); } catch { toast("พื้นที่จัดเก็บไม่พอ กรุณาใช้ภาพขนาดเล็กลงหรือกดล้างภาพเดิม","error"); } }
  function activeProject(){ return state.projects.find(p => p.id === state.activeProjectId) || state.projects[0]; }
  function toast(message, kind = "info"){
    const el = $("toast"); el.textContent = message; el.style.borderColor = kind === "error" ? "#f35b5b" : kind === "success" ? "#68d46f" : "#4f7188";
    el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function navigate(page){
    const target = $("page-" + page); if (!target) return;
    $$(".page").forEach(el => el.classList.toggle("active", el === target));
    $$('[data-page]').forEach(el => el.classList.toggle("active", el.dataset.page === page));
    window.scrollTo({top:0, behavior:"smooth"});
    if (page === "projects") renderProjects();
    if (page === "reports") renderReports();
    if (page === "sunpath") setTimeout(drawAROverlay, 80);
    if (page === "map") {
      if(!mapInstance && window.L) initMap();
      setTimeout(() => { if(mapInstance) { mapInstance.invalidateSize(); mapUseProjectLocation(); } }, 200);
    }
  }

  function setFormValues(inputs){
    Object.entries({...defaultInputs, ...inputs}).forEach(([key, value]) => { if ($(key)) $(key).value = value; });
  }
  function readInputs(){
    const values = {};
    Object.keys(defaultInputs).forEach(key => values[key] = number(key, defaultInputs[key]));
    return values;
  }

  function getRecommendedTilt(latitude, season = "annual"){
    const lat = Math.abs(Number(latitude) || 0);
    if (season === "summer") return round(clamp(lat - 10, 5, 30), 0);
    if (season === "winter") return round(clamp(lat + 12, 10, 45), 0);
    return round(clamp(lat, 10, 35), 0);
  }
  function directionFor(latitude){ return Number(latitude) >= 0 ? {name:"ทิศใต้", azimuth:180} : {name:"ทิศเหนือ", azimuth:0}; }
  function nearestInverter(target){ return STANDARD_INVERTERS.find(v => v >= target) || Math.ceil(target / 10) * 10; }

  function calculate(){
    const input = readInputs();
    const project = activeProject();
    const mode = project.mode || "hybrid";
    const dailyEnergy = input.monthlyEnergy / 30;
    const performanceRatio = clamp((1 - input.systemLoss / 100) * (1 - input.shadeLoss / 100), .35, .95);
    const pvRequired = dailyEnergy / Math.max(.1, input.sunHours * performanceRatio);
    const panels = Math.max(1, Math.ceil(pvRequired * 1000 / input.panelWatt));
    const arrayPower = panels * input.panelWatt / 1000;
    const moduleSize = Number(state.equipment.batteryModule) || 5.12;
    const inverterEfficiency = (Number(state.equipment.inverterEfficiency) || 96.5) / 100;
    const backupEnergy = mode === "on-grid" ? 0 : mode === "off-grid" ? dailyEnergy : dailyEnergy * input.backupHours / 24;
    const rawBattery = backupEnergy / Math.max(.2, (input.batteryDod / 100) * inverterEfficiency);
    const batteryModules = rawBattery > 0 ? Math.ceil(rawBattery / moduleSize) : 0;
    const batteryKwh = batteryModules * moduleSize;
    const dcAcRatio = Number(state.equipment.dcAcRatio) || 1.15;
    const inverterTarget = Math.max(input.peakLoad * (1 + input.inverterMargin / 100), arrayPower / dcAcRatio);
    const inverter = nearestInverter(inverterTarget);
    const direction = directionFor(input.latitude);
    const tilt = getRecommendedTilt(input.latitude);
    const monthlyYield = arrayPower * input.sunHours * performanceRatio * 30;
    const monthlySaving = Math.min(input.monthlyEnergy, monthlyYield) * input.tariff;
    const area = panels * (Number(state.equipment.panelArea) || 2.65);
    const annualCo2 = monthlyYield * 12 * .42 / 1000;
    const orientationDifference = Math.abs((((input.roofAzimuth - direction.azimuth) + 540) % 360) - 180);
    const orientationFactor = clamp(1 - orientationDifference / 360, .55, 1);
    const tiltDifference = Math.abs(input.roofTilt - tilt);
    const tiltFactor = clamp(1 - tiltDifference / 120, .7, 1);
    const efficiency = round(performanceRatio * orientationFactor * tiltFactor * 100, 0);
    currentResult = {panels,arrayPower,batteryKwh,batteryModules,inverter,tilt,direction,monthlyYield,monthlySaving,area,annualCo2,efficiency,performanceRatio,dailyEnergy};
    updateResultUI(currentResult, input);
    return currentResult;
  }

  function updateResultUI(r, input){
    $("panelCount").textContent = r.panels; $("arrayPower").textContent = `กำลังรวม ${fmt(r.arrayPower,2)} kWp`;
    $("batterySize").textContent = fmt(r.batteryKwh,1); $("batteryVoltageLabel").textContent = `แรงดันระบบ ${input.batteryVoltage} V`;
    $("inverterSize").textContent = r.inverter; $("phaseLabel").textContent = activeProject().phase === "3" ? "3 เฟส | 380V" : "1 เฟส | 220V";
    $("tiltAngle").textContent = r.tilt; $("directionText").textContent = r.direction.name; $("azimuthValue").textContent = r.direction.azimuth;
    $("compassNeedle").style.transform = `rotate(${r.direction.azimuth}deg)`;
    $("resultSystem").textContent = `${fmt(r.arrayPower,2)} kWp`;
    $("resultYield").textContent = `${fmt(r.monthlyYield)} kWh/เดือน`;
    $("resultSaving").textContent = `${fmt(r.monthlySaving)} บาท/เดือน`;
    $("resultArea").textContent = `${fmt(r.area,1)} ตร.ม.`;
    renderPanels(r.panels); renderSunPath(); drawAROverlay();
  }

  function renderPanels(count){
    const el = $("panelArray"); el.innerHTML = "";
    const visible = Math.min(count, 24); const cols = visible <= 12 ? 4 : 6;
    el.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    for(let i=0;i<visible;i++){ const panel=document.createElement("i"); panel.className="mini-panel"; el.append(panel); }
  }

  function solarPosition(date, latitude, longitude){
    const rad = Math.PI / 180, deg = 180 / Math.PI;
    const start = Date.UTC(date.getFullYear(),0,0); const now = Date.UTC(date.getFullYear(),date.getMonth(),date.getDate());
    const day = Math.floor((now-start)/86400000); const hour = date.getHours()+date.getMinutes()/60;
    const gamma = 2*Math.PI/365*(day-1+(hour-12)/24);
    const eqTime = 229.18*(0.000075+0.001868*Math.cos(gamma)-0.032077*Math.sin(gamma)-0.014615*Math.cos(2*gamma)-0.040849*Math.sin(2*gamma));
    const decl = 0.006918-0.399912*Math.cos(gamma)+0.070257*Math.sin(gamma)-0.006758*Math.cos(2*gamma)+0.000907*Math.sin(2*gamma)-0.002697*Math.cos(3*gamma)+0.00148*Math.sin(3*gamma);
    const timezone = -date.getTimezoneOffset()/60; let trueSolar = hour*60 + eqTime + 4*longitude - 60*timezone; trueSolar = ((trueSolar%1440)+1440)%1440;
    const hourAngle = (trueSolar/4 - 180)*rad; const lat = latitude*rad;
    const cosZenith = clamp(Math.sin(lat)*Math.sin(decl)+Math.cos(lat)*Math.cos(decl)*Math.cos(hourAngle),-1,1);
    const zenith = Math.acos(cosZenith); const elevation = 90-zenith*deg;
    let azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle)*Math.sin(lat)-Math.tan(decl)*Math.cos(lat))*deg+180;
    azimuth = ((azimuth%360)+360)%360;
    return {azimuth,elevation};
  }

  function seasonDate(){
    const season = document.querySelector("#seasonMode .active")?.dataset.value || "rainy";
    const year = new Date().getFullYear();
    if (season === "summer") return new Date(year,3,15);
    if (season === "winter") return new Date(year,11,15);
    return new Date(year,7,15);
  }
  function simulationDate(minutes = number("timeSlider",720)){
    const date = seasonDate(); date.setHours(Math.floor(minutes/60),minutes%60,0,0); return date;
  }
  function renderSunPath(){
    const input = readInputs(); const group = $("sunMarkers"); group.innerHTML="";
    const times=[6,9,12,15,18]; const positions=[];
    times.forEach((hour,index)=>{
      const d=seasonDate(); d.setHours(hour,0,0,0); const sun=solarPosition(d,input.latitude,input.longitude); positions.push(sun);
      const x=35+(430*(hour-6)/12); const visibleElevation=Math.max(0,sun.elevation); const y=225-Math.sin(Math.PI*(hour-6)/12)*Math.min(205,100+visibleElevation*1.5);
      const ns="http://www.w3.org/2000/svg"; const marker=document.createElementNS(ns,"g"); marker.setAttribute("class","sun-marker"); marker.innerHTML=`<circle cx="${x}" cy="${y}" r="10"></circle><text x="${x}" y="${Math.max(18,y-18)}">${String(hour).padStart(2,"0")}:00</text>`; group.append(marker);
    });
    const noon=positions[2]; $("sunAzimuth").textContent=fmt(noon.azimuth); $("sunElevation").textContent=fmt(Math.max(0,noon.elevation));
    $("sunDirection").textContent=directionName(noon.azimuth); $("sunDateLabel").textContent=`15 ${THAI_MONTHS[seasonDate().getMonth()]} • ตำแหน่งโครงการ`;
  }
  function directionName(azimuth){
    const dirs=["ทิศเหนือ","ตะวันออกเฉียงเหนือ","ทิศตะวันออก","ตะวันออกเฉียงใต้","ทิศใต้","ตะวันตกเฉียงใต้","ทิศตะวันตก","ตะวันตกเฉียงเหนือ"];
    return dirs[Math.round(((azimuth%360)+360)%360/45)%8];
  }

  function renderProjectSelector(){
    const select=$("projectSelect"); select.innerHTML="";
    state.projects.forEach(p=>{const o=document.createElement("option");o.value=p.id;o.textContent=p.name;select.append(o)}); select.value=state.activeProjectId;
    const p=activeProject(); $("locationLabel").textContent=p.location; setModeButtons(p.mode,p.phase);
  }
  function setModeButtons(mode,phase){
    $$("#systemMode button").forEach(b=>b.classList.toggle("active",b.dataset.value===mode));
    $$("#phaseMode button").forEach(b=>b.classList.toggle("active",b.dataset.value===phase));
  }
  function loadProject(id){
    const p=state.projects.find(item=>item.id===id); if(!p)return;
    state.activeProjectId=id; persist(); setFormValues(p.inputs); renderProjectSelector(); calculate(); toast(`เปิดโครงการ “${p.name}” แล้ว`);
  }
  function saveCurrentProject(message=true){
    const p=activeProject(); p.inputs=readInputs(); p.result=calculate(); p.updatedAt=new Date().toISOString(); persist(); renderProjectSelector(); renderProjects(); renderReports(); if(message)toast("บันทึกข้อมูลโครงการเรียบร้อย", "success");
  }
  function renderProjects(){
    const list=$("projectList"); list.innerHTML="";
    state.projects.forEach(p=>{
      const r=p.result || estimateFromInputs(p); const article=document.createElement("article"); article.className="card project-card";
      article.innerHTML=`<div class="project-card-head"><div><h2>${escapeHtml(p.name)}</h2><p>● ${escapeHtml(p.location)}</p></div><span class="status-pill">${p.mode.toUpperCase()}</span></div><div class="project-card-stats"><div><span>กำลังระบบ</span><b>${fmt(r.arrayPower,2)} kWp</b></div><div><span>จำนวนแผง</span><b>${r.panels} แผง</b></div><div><span>มุมเอียง</span><b>${r.tilt}°</b></div></div><div class="project-card-actions"><button class="secondary open-project" data-id="${p.id}">เปิดโครงการ</button><button class="secondary danger delete-project" data-id="${p.id}">ลบ</button></div>`;
      list.append(article);
    });
  }
  function createProject(name,location){
    const p={id:uid(),name,location,mode:"hybrid",phase:"1",inputs:{...defaultInputs,sunHours:Number(state.settings.defaultSunHours)||4.7},result:null,updatedAt:new Date().toISOString(),surveys:[]};
    state.projects.push(p); state.activeProjectId=p.id; persist(); setFormValues(p.inputs); renderProjectSelector(); calculate(); renderProjects(); toast("สร้างโครงการใหม่เรียบร้อย", "success");
  }
  function deleteProject(id){
    if(state.projects.length===1){toast("ต้องมีโครงการอย่างน้อย 1 โครงการ","error");return}
    const p=state.projects.find(x=>x.id===id); if(!confirm(`ลบโครงการ “${p?.name || ""}” หรือไม่?`))return;
    state.projects=state.projects.filter(x=>x.id!==id); if(state.activeProjectId===id)state.activeProjectId=state.projects[0].id; persist(); loadProject(state.activeProjectId); renderProjects(); toast("ลบโครงการแล้ว");
  }
  function escapeHtml(value){const d=document.createElement("div");d.textContent=value;return d.innerHTML}

  function renderReports(){
    const rows=$("reportTable"); rows.innerHTML=""; let power=0,yieldTotal=0,co2=0;
    state.projects.forEach(p=>{const r=p.result||estimateFromInputs(p);power+=r.arrayPower;yieldTotal+=r.monthlyYield;co2+=r.annualCo2;const tr=document.createElement("tr");tr.innerHTML=`<td>${escapeHtml(p.name)}</td><td>${p.mode.toUpperCase()} / ${p.phase} เฟส</td><td>${r.panels} แผง</td><td>${fmt(r.batteryKwh,1)} kWh</td><td>${r.inverter} kW</td><td>${r.tilt}°</td><td>${new Date(p.updatedAt).toLocaleDateString("th-TH")}</td>`;rows.append(tr)});
    $("reportProjects").textContent=state.projects.length; $("reportPower").textContent=fmt(power,1); $("reportYield").textContent=fmt(yieldTotal); $("reportCo2").textContent=fmt(co2,1);
  }
  function estimateFromInputs(p){
    const i={...defaultInputs,...p.inputs}; const pr=(1-i.systemLoss/100)*(1-i.shadeLoss/100);const panels=Math.ceil((i.monthlyEnergy/30)/(i.sunHours*pr)*1000/i.panelWatt);const arrayPower=panels*i.panelWatt/1000;const monthlyYield=arrayPower*i.sunHours*pr*30;const backup=p.mode==="on-grid"?0:p.mode==="off-grid"?i.monthlyEnergy/30:i.monthlyEnergy/30*i.backupHours/24;const moduleSize=Number(state.equipment.batteryModule)||5.12;const batteryKwh=backup?Math.ceil(backup/((i.batteryDod/100)*.965)/moduleSize)*moduleSize:0;const inverter=nearestInverter(Math.max(i.peakLoad*(1+i.inverterMargin/100),arrayPower/(Number(state.equipment.dcAcRatio)||1.15)));return{panels,arrayPower,monthlyYield,batteryKwh,inverter,tilt:getRecommendedTilt(i.latitude),annualCo2:monthlyYield*12*.42/1000};
  }
  function exportCsv(){
    const lines=[["โครงการ","สถานที่","ระบบ","เฟส","จำนวนแผง","กำลังแผงรวม kWp","แบตเตอรี่ kWh","อินเวอร์เตอร์ kW","มุมเอียง"]];
    state.projects.forEach(p=>{const r=p.result||estimateFromInputs(p);lines.push([p.name,p.location,p.mode,p.phase,r.panels,r.arrayPower,r.batteryKwh,r.inverter,r.tilt])});
    const csv="\ufeff"+lines.map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\n"); downloadBlob(csv,"nexora-solar-report.csv","text/csv;charset=utf-8");
  }
  function downloadBlob(content,filename,type){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type}));a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}

  async function useCurrentLocation(){
    if(!navigator.geolocation){toast("อุปกรณ์นี้ไม่รองรับ GPS","error");return}
    toast("กำลังขอตำแหน่ง GPS…");
    navigator.geolocation.getCurrentPosition(pos=>{ $("latitude").value=pos.coords.latitude.toFixed(5);$("longitude").value=pos.coords.longitude.toFixed(5);activeProject().location=`GPS ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;renderProjectSelector();calculate();toast("รับตำแหน่ง GPS แล้ว","success") },err=>toast(geoError(err),"error"),{enableHighAccuracy:true,timeout:12000,maximumAge:60000});
  }
  function geoError(err){return err.code===1?"กรุณาอนุญาตการเข้าถึงตำแหน่งในเบราว์เซอร์":err.code===3?"ค้นหาตำแหน่งไม่ทันเวลา กรุณาลองใหม่":"ไม่สามารถอ่านตำแหน่ง GPS ได้"}

  async function startCamera(){
    if(!navigator.mediaDevices?.getUserMedia){toast("กล้องเว็บต้องเปิดผ่าน HTTPS หรือ localhost","error");return}
    try{
      cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
      $("cameraVideo").srcObject=cameraStream;await $("cameraVideo").play();$("cameraPlaceholder").style.display="none";$("startCamera").disabled=true;$("stopCamera").disabled=false;drawLoop();toast("เปิดกล้องแล้ว ให้หันไปยังพื้นที่ติดตั้ง","success");
    }catch(err){const message=err.name==="NotAllowedError"?"กรุณาอนุญาตกล้อง แล้วเปิดหน้าเว็บใหม่":"เปิดกล้องไม่สำเร็จ กรุณาตรวจสิทธิ์และใช้ HTTPS";toast(message,"error")}
  }
  function stopCamera(){if(cameraStream)cameraStream.getTracks().forEach(t=>t.stop());cameraStream=null;cancelAnimationFrame(animationFrame);$("cameraVideo").srcObject=null;$("cameraPlaceholder").style.display="flex";$("startCamera").disabled=false;$("stopCamera").disabled=true;drawAROverlay()}
  async function enableCompass(){
    try{
      if(typeof DeviceOrientationEvent!=="undefined"&&typeof DeviceOrientationEvent.requestPermission==="function"){
        const permission=await DeviceOrientationEvent.requestPermission();if(permission!=="granted")throw new Error("denied");
      }
      window.addEventListener("deviceorientationabsolute",orientationHandler,true);window.addEventListener("deviceorientation",orientationHandler,true);toast("เปิดเข็มทิศแล้ว กรุณาหมุนมือถือเป็นรูปเลข 8 หากทิศไม่ตรง","success");
    }catch{toast("ไม่สามารถเปิดเข็มทิศได้ กรุณาอนุญาต Motion & Orientation","error")}
  }
  function orientationHandler(event){const heading=event.webkitCompassHeading??(event.alpha==null?null:(360-event.alpha));if(heading!=null){deviceHeading=(heading+360)%360;$("deviceHeading").textContent=fmt(deviceHeading);$("cameraHeading").textContent=`${directionName(deviceHeading)} ${fmt(deviceHeading)}°`}}
  function drawLoop(){drawAROverlay();animationFrame=requestAnimationFrame(drawLoop)}
  function drawAROverlay(){
    const canvas=$("arOverlay"),stage=$("cameraStage");if(!canvas||!stage)return;const w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;const dpr=Math.min(devicePixelRatio||1,2);if(canvas.width!==w*dpr||canvas.height!==h*dpr){canvas.width=w*dpr;canvas.height=h*dpr}const ctx=canvas.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const input=readInputs();const date=simulationDate();const sun=solarPosition(date,input.latitude,input.longitude);const heading=deviceHeading??input.roofAzimuth;const fov=number("fovSlider",65);const obstacle=number("obstacleSlider",35);const relative=((((sun.azimuth-heading)+540)%360)-180);const x=w/2+(relative/fov)*w;const y=clamp(h*(1-sun.elevation/90),70,h-125);
    const points=[];for(let mins=360;mins<=1080;mins+=20){const d=simulationDate(mins),s=solarPosition(d,input.latitude,input.longitude),rel=((((s.azimuth-heading)+540)%360)-180);if(Math.abs(rel)<=fov*.75&&s.elevation>0)points.push([w/2+(rel/fov)*w,clamp(h*(1-s.elevation/90),70,h-110)]);}
    ctx.lineWidth=3;ctx.strokeStyle="#f5b51b";ctx.setLineDash([10,8]);ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();ctx.setLineDash([]);
    const obstacleY=clamp(h*(1-obstacle/90),90,h-125);const grad=ctx.createLinearGradient(w*.6,obstacleY,w,h);grad.addColorStop(0,"rgba(243,91,91,.08)");grad.addColorStop(1,"rgba(243,91,91,.46)");ctx.fillStyle=grad;ctx.beginPath();ctx.moveTo(w*.62,h-105);ctx.lineTo(w,obstacleY);ctx.lineTo(w,h-105);ctx.closePath();ctx.fill();ctx.strokeStyle="#f35b5b";ctx.lineWidth=2;ctx.stroke();
    const inView=Math.abs(relative)<=fov/2&&sun.elevation>0;const risk=inView&&sun.elevation<=obstacle+5;if(inView){ctx.shadowColor="#f5b51b";ctx.shadowBlur=18;ctx.fillStyle="#f5b51b";ctx.beginPath();ctx.arc(x,y,13,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;ctx.strokeStyle="#fff1a8";ctx.lineWidth=2;ctx.stroke();ctx.fillStyle="white";ctx.font="700 14px sans-serif";ctx.textAlign="center";ctx.fillText(formatTime(number("timeSlider",720)),x,y-23)}
    ctx.strokeStyle="rgba(104,212,111,.85)";ctx.lineWidth=3;ctx.strokeRect(w*.14,h*.52,w*.44,h*.2);ctx.fillStyle="rgba(104,212,111,.15)";ctx.fillRect(w*.14,h*.52,w*.44,h*.2);ctx.fillStyle="#b9f3bd";ctx.font="700 13px sans-serif";ctx.fillText("พื้นที่ติดตั้งแนะนำ",w*.36,h*.52+25);
    $("arAzimuth").textContent=fmt(sun.azimuth);$("arElevation").textContent=fmt(Math.max(0,sun.elevation));$("shadowAlert").textContent=risk?`⚠ เสี่ยงเงาบังเวลา ${formatTime(number("timeSlider",720))}`:inView?"✓ ตำแหน่งดวงอาทิตย์ไม่ถูกบัง":"หมุนกล้องตามเส้นทางดวงอาทิตย์";$("shadowAlert").style.borderColor=risk?"#f35b5b":"#68d46f";updateShadowWindow(heading,fov,obstacle,input);
  }
  function updateShadowWindow(heading,fov,obstacle,input){
    const risky=[];for(let mins=360;mins<=1080;mins+=10){const s=solarPosition(simulationDate(mins),input.latitude,input.longitude),rel=Math.abs(((((s.azimuth-heading)+540)%360)-180));if(s.elevation>0&&rel<=fov/2&&s.elevation<=obstacle+5)risky.push(mins)}
    const text=risky.length?`${formatTime(risky[0])}–${formatTime(risky[risky.length-1])}`:"ไม่พบในมุมกล้อง";$("shadowWindow").textContent=text;$("placementAdvice").textContent=risky.length?"แนะนำขยับแผงออกจากแนวสิ่งกีดขวาง หรือสำรวจซ้ำจากอีกมุม":"มุมกล้องนี้เหมาะสำหรับตรวจตำแหน่งติดตั้งต่อ";
  }
  function formatTime(minutes){return `${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`}
  function captureSurvey(){
    if(!cameraStream){toast("กรุณาเปิดกล้องก่อนบันทึกภาพ","error");return}const video=$("cameraVideo"),overlay=$("arOverlay"),out=document.createElement("canvas");out.width=video.videoWidth||1280;out.height=video.videoHeight||720;const ctx=out.getContext("2d");ctx.drawImage(video,0,0,out.width,out.height);ctx.drawImage(overlay,0,0,out.width,out.height);out.toBlob(blob=>{const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`nexora-sun-survey-${Date.now()}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},"image/png");const p=activeProject();p.surveys=p.surveys||[];p.surveys.push({date:new Date().toISOString(),time:formatTime(number("timeSlider",720)),season:document.querySelector("#seasonMode .active")?.dataset.value,shadow:$("shadowWindow").textContent});persist();toast("บันทึกภาพและผลสำรวจแล้ว","success")
  }

  function initMap(){
    if(!window.L || mapInstance) return;
    mapInstance = L.map("satelliteMap", {zoomControl: false}).setView([state.projects[0].inputs.latitude, state.projects[0].inputs.longitude], 18);
    L.control.zoom({position: 'bottomleft'}).addTo(mapInstance);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18, attribution: 'Tiles &copy; Esri'
    }).addTo(mapInstance);
    
    mapDrawLayer = L.layerGroup().addTo(mapInstance);
    
    mapInstance.on('click', e => {
      mapPolyPoints.push(e.latlng);
      drawMapPolygon();
    });
  }

  function drawMapPolygon() {
    mapDrawLayer.clearLayers();
    if(mapPolyPoints.length === 0) return;
    
    const input = readInputs();
    L.marker([input.latitude, input.longitude]).addTo(mapDrawLayer).bindPopup("ตำแหน่งอ้างอิง");

    mapPolyPoints.forEach(p => {
      L.circleMarker(p, {radius: 4, color: '#f5b51b', fillColor: '#fff', fillOpacity: 1}).addTo(mapDrawLayer);
    });
    
    if(mapPolyPoints.length > 1) {
      mapPolygon = L.polygon(mapPolyPoints, {color: '#68d46f', weight: 2, fillColor: '#68d46f', fillOpacity: 0.3}).addTo(mapDrawLayer);
      if(mapPolyPoints.length > 2) calculateMapArea();
    }
  }

  function clearMapPoly() {
    mapPolyPoints = [];
    mapPolygon = null;
    mapDrawLayer.clearLayers();
    const input = readInputs();
    L.marker([input.latitude, input.longitude]).addTo(mapDrawLayer).bindPopup("ตำแหน่งอ้างอิง").openPopup();
    if($("mapArea")) $("mapArea").textContent = "0.0";
    if($("mapCapacity")) $("mapCapacity").textContent = "รองรับได้ 0 แผง";
    if($("mapApplyArea")) $("mapApplyArea").disabled = true;
    if($("mapDrawPoly")) $("mapDrawPoly").style.borderColor = "";
    if(mapInstance) mapInstance._container.style.cursor = "";
  }

  function calculateMapArea() {
    if(mapPolyPoints.length < 3) return;
    const earthRadius = 6378137;
    let area = 0;
    for (let i = 0; i < mapPolyPoints.length; i++) {
      let p1 = mapPolyPoints[i];
      let p2 = mapPolyPoints[(i + 1) % mapPolyPoints.length];
      area += (p2.lng - p1.lng) * Math.PI / 180 * (2 + Math.sin(p1.lat * Math.PI / 180) + Math.sin(p2.lat * Math.PI / 180));
    }
    area = Math.abs(area * earthRadius * earthRadius / 2.0);
    if($("mapArea")) $("mapArea").textContent = fmt(area, 1);
    
    const panelArea = Number(state.equipment.panelArea) || 2.65;
    const panels = Math.floor((area * 0.8) / panelArea);
    if($("mapCapacity")) $("mapCapacity").textContent = `รองรับได้ ${panels} แผง`;
    if($("mapApplyArea")) {
      $("mapApplyArea").disabled = false;
      $("mapApplyArea").dataset.panels = panels;
      $("mapApplyArea").dataset.area = area;
    }
  }

  function mapUseProjectLocation() {
    const input = readInputs();
    if(mapInstance) {
      mapInstance.setView([input.latitude, input.longitude], 18);
      clearMapPoly();
    }
  }

  function saveEquipment(){
    state.equipment={panelModel:$("panelModel").value,panelWatt:number("equipmentPanelWatt",550),panelArea:number("panelArea",2.65),batteryModel:$("batteryModel").value,batteryModule:number("batteryModule",5.12),batteryDod:number("equipmentDod",90),inverterModel:$("inverterModel").value,inverterEfficiency:number("inverterEfficiency",96.5),dcAcRatio:number("dcAcRatio",1.15)};
    $("panelWatt").value=state.equipment.panelWatt;$("batteryDod").value=state.equipment.batteryDod;persist();calculate();toast("บันทึกค่าอุปกรณ์แล้ว","success");
  }
  function applySettings(){
    const background=state.settings.background||{};
    const root=document.documentElement;
    root.style.setProperty("--font-scale",state.settings.fontScale);
    root.style.setProperty("--user-bg-image",background.dataUrl?`url("${background.dataUrl}")`:"none");
    root.style.setProperty("--user-bg-opacity",String((Number(background.opacity)||0)/100));
    root.style.setProperty("--user-bg-blur",`${Number(background.blur)||0}px`);
    root.style.setProperty("--user-bg-position",background.position||"center center");
    root.style.setProperty("--user-bg-size",background.size||"cover");
    document.body.classList.toggle("has-user-bg",!!background.dataUrl);
    document.body.classList.toggle("high-contrast",!!state.settings.highContrast);
    updateBackgroundControls();
  }
  function readBackgroundControls(){
    const current=state.settings.background||{};
    return {...current,opacity:number("backgroundOpacity",18),blur:number("backgroundBlur",0),position:$("backgroundPosition")?.value||"center center",size:$("backgroundSize")?.value||"cover"};
  }
  function updateBackgroundControls(){
    const background=state.settings.background||{};
    if($("backgroundOpacity"))$("backgroundOpacity").value=background.opacity??18;
    if($("backgroundBlur"))$("backgroundBlur").value=background.blur??0;
    if($("backgroundPosition"))$("backgroundPosition").value=background.position||"center center";
    if($("backgroundSize"))$("backgroundSize").value=background.size||"cover";
    if($("backgroundOpacityValue"))$("backgroundOpacityValue").textContent=background.opacity??18;
    if($("backgroundBlurValue"))$("backgroundBlurValue").textContent=background.blur??0;
    const preview=$("backgroundPreview");
    if(preview){preview.classList.toggle("has-image",!!background.dataUrl);preview.style.backgroundImage=background.dataUrl?`url("${background.dataUrl}")`:"";preview.style.backgroundPosition=background.position||"center center";preview.style.backgroundSize=background.size||"cover";}
  }
  function saveSettings(){
    state.settings={...state.settings,fontScale:$("fontScale").value,highContrast:$("highContrast").checked,defaultLocation:$("defaultLocation").value,defaultSunHours:number("defaultSunHours",4.7),background:readBackgroundControls()};
    persist();applySettings();toast("บันทึกการตั้งค่าแล้ว","success");
  }
  function saveBackground(){state.settings.background=readBackgroundControls();persist();applySettings();toast("บันทึกภาพพื้นหลังแล้ว","success")}
  function clearBackground(){state.settings.background={...(state.settings.background||{}),dataUrl:null,cleared:true};persist();applySettings();toast("ล้างภาพพื้นหลังแล้ว","success")}
  function resizeBackground(file){
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onerror=()=>reject(new Error("อ่านไฟล์ไม่สำเร็จ"));reader.onload=()=>{const image=new Image();image.onerror=()=>reject(new Error("ภาพไม่ถูกต้อง"));image.onload=()=>{const max=1920,scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight));const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL("image/jpeg",.82))};image.src=reader.result};reader.readAsDataURL(file);
    });
  }
  async function handleBackgroundUpload(event){
    const file=event.target.files?.[0];if(!file)return;if(file.size>20*1024*1024){toast("ภาพใหญ่เกิน 20 MB กรุณาเลือกภาพที่เล็กลง","error");event.target.value="";return}
    try{
      const dataUrl = await resizeBackground(file);
      const bg = state.settings.background || {};
      state.settings.background = {...bg, dataUrl: dataUrl, opacity: bg.opacity === 18 ? 100 : (bg.opacity || 100)};
      applySettings();
      toast("เพิ่มภาพพื้นหลังแล้ว กด “บันทึกภาพพื้นหลัง” เพื่อเก็บค่า","success");
    }catch{toast("ไม่สามารถอ่านภาพนี้ได้","error")}
    event.target.value="";
  }
  async function requestNotifications(){if(!("Notification" in window)){toast("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน","error");return}const result=await Notification.requestPermission();if(result==="granted"){new Notification("NEXORA Solar Planner",{body:"เปิดการแจ้งเตือนเรียบร้อย"});toast("เปิดการแจ้งเตือนแล้ว","success")}else toast("ยังไม่ได้รับอนุญาตการแจ้งเตือน","error")}

  function bindEvents(){
    $$('[data-page]').forEach(el=>el.addEventListener("click",()=>navigate(el.dataset.page)));$$('[data-go]').forEach(el=>el.addEventListener("click",()=>navigate(el.dataset.go)));
    $("projectSelect").addEventListener("change",e=>loadProject(e.target.value));
    $("systemMode").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;activeProject().mode=b.dataset.value;setModeButtons(activeProject().mode,activeProject().phase);calculate()});
    $("phaseMode").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;activeProject().phase=b.dataset.value;setModeButtons(activeProject().mode,activeProject().phase);calculate()});
    $("calculatorForm").addEventListener("input",()=>calculate());$("calculateNow").addEventListener("click",calculate);$("applyCalculation").addEventListener("click",()=>{saveCurrentProject(false);navigate("dashboard");toast("นำผลคำนวณไปใช้บน Dashboard แล้ว","success")});
    $("quickSave").addEventListener("click",()=>saveCurrentProject());$("saveFromCalculator").addEventListener("click",()=>saveCurrentProject());$("useLocation").addEventListener("click",useCurrentLocation);$("cameraLocation").addEventListener("click",useCurrentLocation);
    $("newProject").addEventListener("click",()=>$("projectDialog").showModal());$$('[data-close-dialog]').forEach(button=>button.addEventListener("click",()=>$("projectDialog").close()));$("projectList").addEventListener("click",e=>{const open=e.target.closest(".open-project"),del=e.target.closest(".delete-project");if(open){loadProject(open.dataset.id);navigate("dashboard")}if(del)deleteProject(del.dataset.id)});
    $("projectForm").addEventListener("submit",e=>{e.preventDefault();const name=$("projectNameInput").value.trim(),location=$("projectLocationInput").value.trim();if(!name||!location)return;createProject(name,location);$("projectDialog").close();$("projectForm").reset();$("projectLocationInput").value=state.settings.defaultLocation});
    $("saveEquipment").addEventListener("click",saveEquipment);$("exportCsv").addEventListener("click",exportCsv);$("printReport").addEventListener("click",()=>window.print());
    $("saveSettings").addEventListener("click",saveSettings);$("enableNotifications").addEventListener("click",requestNotifications);$("notificationButton").addEventListener("click",requestNotifications);
    $("backgroundImageInput").addEventListener("change",handleBackgroundUpload);$("saveBackground").addEventListener("click",saveBackground);$("clearBackground").addEventListener("click",clearBackground);document.querySelector(".upload-dropzone")?.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();$("backgroundImageInput").click()}});
    ["backgroundOpacity","backgroundBlur","backgroundPosition","backgroundSize"].forEach(id=>{const update=()=>{state.settings.background=readBackgroundControls();applySettings()};$(id).addEventListener("input",update);$(id).addEventListener("change",update)});
    $("startCamera").addEventListener("click",startCamera);$("stopCamera").addEventListener("click",stopCamera);$("enableCompass").addEventListener("click",enableCompass);$("captureSurvey").addEventListener("click",captureSurvey);
    ["timeSlider","obstacleSlider","fovSlider"].forEach(id=>$(id).addEventListener("input",()=>{if(id==="timeSlider")$("timeValue").textContent=formatTime(number(id));if(id==="obstacleSlider")$("obstacleValue").textContent=number(id);if(id==="fovSlider")$("fovValue").textContent=number(id);drawAROverlay()}));
    $("seasonMode").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;$$("#seasonMode button").forEach(x=>x.classList.toggle("active",x===b));const labels={summer:"ฤดูร้อน",rainy:"ฤดูฝน",winter:"ฤดูหนาว"};$("seasonBadge").textContent=labels[b.dataset.value];renderSunPath();drawAROverlay()});
    window.addEventListener("resize",drawAROverlay);window.addEventListener("beforeunload",stopCamera);
    window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredInstall=e;$("installApp").hidden=false});$("installApp").addEventListener("click",async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$("installApp").hidden=true});
    if($("mapDrawPoly")) $("mapDrawPoly").addEventListener("click", () => {
      toast("คลิกจุดบนแผนที่ตามมุมหลังคาได้เลยครับ");
    });
    if($("mapClearPoly")) $("mapClearPoly").addEventListener("click", clearMapPoly);
    if($("mapUseLocation")) $("mapUseLocation").addEventListener("click", mapUseProjectLocation);
    if($("mapApplyArea")) $("mapApplyArea").addEventListener("click", () => {
      if($("mapApplyArea").disabled) return;
      toast(`พื้นที่ ${$("mapArea").textContent} ตร.ม. รองรับแผงได้สูงสุด ${$("mapApplyArea").dataset.panels} แผง`, "success");
      navigate("dashboard");
    });
  }

  function init(){
    const now=new Date();$("currentDate").textContent=`${now.getDate()} ${THAI_MONTHS[now.getMonth()]}`;
    const p=activeProject();setFormValues(p.inputs);renderProjectSelector();
    Object.entries(state.equipment).forEach(([key,value])=>{const map={panelWatt:"equipmentPanelWatt",batteryDod:"equipmentDod"};const el=$(map[key]||key);if(el)el.value=value});
    $("fontScale").value=state.settings.fontScale;$("highContrast").checked=state.settings.highContrast;$("defaultLocation").value=state.settings.defaultLocation;$("defaultSunHours").value=state.settings.defaultSunHours;applySettings();bindEvents();updateBackgroundControls();calculate();renderProjects();renderReports();
    if("serviceWorker" in navigator && location.protocol!=="file:") navigator.serviceWorker.register("sw.js").then(reg=>reg.update()).catch(()=>{});
  }
  document.addEventListener("DOMContentLoaded",init);
})();
