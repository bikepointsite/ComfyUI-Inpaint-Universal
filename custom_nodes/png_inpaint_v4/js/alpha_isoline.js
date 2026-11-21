import { t as inpaintText } from './language.js';
import {nearestVertex,selectArc} from './contour_paths.js';

export function matchingRawArc(visibleLoop,arc,rawLoops){
 const area=loop=>loop.reduce((sum,a,i)=>{const b=loop[(i+1)%loop.length];return sum+a[0]*b[1]-b[0]*a[1];},0)/2;
 const visibleArea=area(visibleLoop);
 // Never snap a visible exterior edge to a tiny hole inside its faint fringe.
 let candidates=rawLoops.filter(loop=>{const a=area(loop);return a*visibleArea>0&&Math.abs(a)>=Math.abs(visibleArea)*.25;});
 if(!candidates.length)candidates=rawLoops.filter(loop=>area(loop)*visibleArea>0);
 if(!candidates.length)return arc.points;
 const a=nearestVertex(candidates,arc.points[0]),loop=candidates[a.loop],b=nearestVertex([loop],arc.points.at(-1));
 const paths=[false,true].map(other=>selectArc(loop,a.index,b.index,other).points);
 const score=path=>{let sum=0;for(let j=0;j<=16;j++){const p=path[Math.round(j*(path.length-1)/16)],q=arc.points[Math.round(j*(arc.points.length-1)/16)];sum+=Math.hypot(p[0]-q[0],p[1]-q[1]);}return sum;};
 return paths.sort((a,b)=>score(a)-score(b))[0];
}

// Marching squares through pixel-centre alpha values, including a zero border.
// The threshold changes geometry only; never binarize the source PNG itself.
export function alphaIsolines(rgba,w,h,threshold=128){
 const level=Math.max(.5,Math.min(254.5,threshold)),segments=[],byKey=new Map();
 const alpha=(x,y)=>x<0||y<0||x>=w||y>=h?0:rgba[(y*w+x)*4+3];
 const key=p=>p.map(v=>Math.round(v*1e6)).join(',');
 const add=(a,b)=>{const i=segments.length;segments.push([a,b]);for(const p of[a,b]){const k=key(p);if(!byKey.has(k))byKey.set(k,[]);byKey.get(k).push(i);}};
 for(let y=-1;y<h;y++)for(let x=-1;x<w;x++){
  const p=[[x+.5,y+.5],[x+1.5,y+.5],[x+1.5,y+1.5],[x+.5,y+1.5]],v=[alpha(x,y),alpha(x+1,y),alpha(x+1,y+1),alpha(x,y+1)];
  const hits=[];for(let i=0;i<4;i++){const j=(i+1)%4;if((v[i]>=level)===(v[j]>=level))continue;const t=(level-v[i])/(v[j]-v[i]);hits.push({edge:i,p:[p[i][0]+(p[j][0]-p[i][0])*t,p[i][1]+(p[j][1]-p[i][1])*t]});}
  if(hits.length===2)add(hits[0].p,hits[1].p);
  if(hits.length===4){const center=v.reduce((s,a)=>s+a)/4>=level,first=v[0]>=level;const pairs=center===first?[[0,1],[2,3]]:[[0,3],[1,2]];for(const[a,b]of pairs)add(hits[a].p,hits[b].p);}
  if(segments.length>200000)throw new Error(inpaintText("Слишком сложная граница. Увеличьте порог или используйте кисть прозрачности."));
 }
 const seen=new Uint8Array(segments.length),loops=[];
 for(let i=0;i<segments.length;i++)if(!seen[i]){const loop=[segments[i][0]],first=key(loop[0]);let index=i,p=segments[i][1];seen[i]=1;
  while(key(p)!==first){loop.push(p);const next=(byKey.get(key(p))||[]).find(j=>!seen[j]);if(next===undefined)break;seen[next]=1;const pair=segments[next];p=key(pair[0])===key(p)?pair[1]:pair[0];index=next;}
  if(loop.length>=4){let area=0;for(let j=0;j<loop.length;j++){const a=loop[j],b=loop[(j+1)%loop.length];area+=a[0]*b[1]-b[0]*a[1];}
   // Orient so opaque material is to the right, matching the original tracer.
   const a=loop[0],b=loop[1],dx=b[0]-a[0],dy=b[1]-a[1],n=Math.hypot(dx,dy)||1;
   const sx=Math.floor((a[0]+b[0])/2-dy/n*.6),sy=Math.floor((a[1]+b[1])/2+dx/n*.6);
   if(alpha(sx,sy)<level)loop.reverse();loops.push(loop);
  }
 }return loops;
}
