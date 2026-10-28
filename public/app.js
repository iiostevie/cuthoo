const state={token:sessionStorage.getItem("cuthoo-token")||"",products:[],filter:"ALL"};
const $=(selector)=>document.querySelector(selector);
const tokenDialog=$("#tokenDialog"),addDialog=$("#addDialog"),logDialog=$("#logDialog"),grid=$("#productGrid");

document.addEventListener("DOMContentLoaded",async()=>{
  await health();
  if(state.token) await loadProducts(); else tokenDialog.showModal();
});

$("#tokenForm").addEventListener("submit",async(event)=>{
  event.preventDefault(); state.token=$("#tokenInput").value.trim(); sessionStorage.setItem("cuthoo-token",state.token); tokenDialog.close(); await loadProducts();
});
$("#addButton").addEventListener("click",()=>state.token?addDialog.showModal():tokenDialog.showModal());
$("#addForm").addEventListener("submit",async(event)=>{
  event.preventDefault();
  const button=$("#saveProduct"); button.disabled=true;
  try{
    await api("/api/products",{method:"POST",body:JSON.stringify({url:$("#urlInput").value,name:$("#nameInput").value,authorizationConfirmed:$("#authorizedInput").checked})});
    addDialog.close(); event.target.reset(); toast("商品監控已建立"); await loadProducts();
  }catch(error){toast(error.message,true)}finally{button.disabled=false}
});
document.querySelectorAll(".filter").forEach(button=>button.addEventListener("click",()=>{
  document.querySelectorAll(".filter").forEach(item=>item.classList.remove("active"));button.classList.add("active");state.filter=button.dataset.filter;render();
}));
grid.addEventListener("click",async(event)=>{
  const button=event.target.closest("button[data-action]");if(!button)return;
  if(button.dataset.action==="logs"){await showPollLogs(button.dataset.id);return}
  if(button.dataset.action==="changes"){await showLogs(button.dataset.id);return}
  try{await api(`/api/products/${encodeURIComponent(button.dataset.id)}/action`,{method:"POST",body:JSON.stringify({action:button.dataset.action})});toast("商品狀態已更新");await loadProducts()}catch(error){toast(error.message,true)}
});

async function health(){try{const response=await fetch("/health");if(!response.ok)throw new Error();$("#healthDot").classList.add("online");$("#healthText").textContent="服務正常"}catch{$("#healthText").textContent="無法連線"}}
async function loadProducts(){try{state.products=await api("/api/products");render()}catch(error){sessionStorage.removeItem("cuthoo-token");state.token="";toast(error.message,true);tokenDialog.showModal()}}
async function api(url,options={}){const response=await fetch(url,{...options,headers:{"content-type":"application/json","x-cuthoo-admin-token":state.token,...options.headers}});const text=await response.text();let data;try{data=text?JSON.parse(text):null}catch{data=null}if(!response.ok)throw new Error(data?.error||text||"Request failed");if(data==null)throw new Error("伺服器回應格式錯誤");return data}
function render(){
  const products=state.products.filter(product=>state.filter==="ALL"||product.status===state.filter);
  $("#activeCount").textContent=state.products.filter(p=>p.status==="ACTIVE").length;
  $("#terminatedCount").textContent=state.products.filter(p=>p.status==="TERMINATED").length;
  $("#unitCount").textContent=number(state.products.reduce((sum,p)=>sum+Number(p.estimated_units||0),0));
  $("#changeCount").textContent=number(state.products.reduce((sum,p)=>sum+Number(p.change_count||0),0));
  grid.innerHTML=products.length?products.map(card).join(""):'<div class="empty">這個狀態目前沒有商品。</div>';
}
function card(product){const controls=product.status==="ACTIVE"?'<button data-action="pause">暫停</button><button data-action="terminate">終止</button>':product.status==="PAUSED"?'<button data-action="resume">恢復</button><button data-action="terminate">終止</button>':'<button data-action="resume">重新啟用</button>';const actions=`<button data-action="changes">數量變化</button><button data-action="logs">完整 Log</button>${controls}`;return `<article class="product-card"><div class="card-top"><div><h3>${escapeHtml(product.title)}</h3><span class="product-id">${escapeHtml(product.id)}</span></div><span class="status ${product.status}">${statusName(product.status)}</span></div><div class="metrics"><div class="metric"><span>推定本數</span><strong>${number(product.estimated_units)}</strong></div><div class="metric"><span>數量變更</span><strong>${number(product.change_count)}</strong></div><div class="metric"><span>平均每次變更</span><strong>${product.average_units_per_change==null?"—":Number(product.average_units_per_change).toFixed(1)}</strong></div></div><div class="reason">${product.reason?`狀態原因：${reasonName(product.reason)}`:""}</div><div class="card-actions">${actions.replaceAll("data-action=",`data-id="${escapeHtml(product.id)}" data-action=`)}</div></article>`}
async function showLogs(id){try{const logs=await api(`/api/products/${encodeURIComponent(id)}/logs`);$("#logProductId").textContent=id;$("#logRows").innerHTML=logs.length?logs.map(log=>`<tr><td>${formatTime(log.observed_at)}</td><td>${escapeHtml(log.outcome)}</td><td>${log.previous_inventory??"—"}</td><td>${log.current_inventory??"—"}</td><td>${log.inventory_delta==null?"—":signed(log.inventory_delta)}</td><td>—</td><td>—</td><td>—</td></tr>`).join(""):'<tr><td colspan="8">尚未產生數量變化記錄。</td></tr>';logDialog.showModal()}catch(error){toast(error.message,true)}}
async function showPollLogs(id){try{
  const logs=await api(`/api/logs?product=${encodeURIComponent(id)}`);$("#logProductId").textContent=id;
  $("#logRows").innerHTML=logs.length?logs.map(log=>`<tr><td>${formatTime(log.observed_at)}</td><td>${escapeHtml(log.outcome)}</td><td>${log.previous_inventory??"—"}</td><td>${log.current_inventory??"—"}</td><td>${log.inventory_delta==null?"—":signed(log.inventory_delta)}</td><td>${log.sold_out==null?"—":log.sold_out?"是":"否"}</td><td>${escapeHtml(log.reason||"—")}</td><td>${log.next_poll_at?formatTime(log.next_poll_at):"—"}</td></tr>`).join(""):'<tr><td colspan="8">新版完整 Log 尚未產生，從下次輪詢開始記錄。</td></tr>';
  logDialog.showModal();
}catch(error){toast(error.message,true)}}
function formatTime(value){return new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(Number(value)))}
function signed(value){return String(Math.abs(Number(value)))}
function statusName(value){return({ACTIVE:"監控中",PAUSED:"已暫停",TERMINATED:"已終止"})[value]||value}
function reasonName(value){return({MANUAL_PAUSE:"手動暫停",MANUAL_UNSUBSCRIBE:"手動停止",PRODUCT_REMOVED:"商品下架",OUT_OF_STOCK:"商品售罄",SALE_ENDED:"活動結束",SHOP_DISABLED:"商店停止販售",RATE_LIMITED:"網站要求降低頻率",ACCESS_DENIED:"網站拒絕存取",PARSE_ERROR:"頁面格式改變",NETWORK_ERROR:"網路錯誤"})[value]||value}
function number(value){return new Intl.NumberFormat("zh-TW").format(Number(value||0))}
function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char])}
function toast(message,error=false){const element=$("#toast");element.textContent=message;element.style.background=error?"#b94136":"#191d27";element.classList.add("show");setTimeout(()=>element.classList.remove("show"),3000)}
