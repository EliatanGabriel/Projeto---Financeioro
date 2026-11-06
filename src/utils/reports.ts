import {jsPDF} from 'jspdf'
import * as XLSX from 'xlsx'
import {saveAs} from 'file-saver'
export function exportCSV(rows:any[],name:string){const csv=rows.map(r=>Object.values(r).map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';')).join('\n');saveAs(new Blob(['\ufeff'+csv],{type:'text/csv'}),name)}
export function exportXLSX(rows:any[],name:string){const ws=XLSX.utils.json_to_sheet(rows);const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Dados');const b=XLSX.write(wb,{bookType:'xlsx',type:'array'});saveAs(new Blob([b],{type:'application/octet-stream'}),name)}
export function exportPDFReport(title:string,lines:string[],name:string){const d=new jsPDF();d.setFontSize(16);d.text(title,14,16);d.setFontSize(11);let y=28;lines.forEach(l=>{if(y>280){d.addPage();y=16}d.text(String(l).slice(0,95),14,y);y+=7});d.save(name)}
