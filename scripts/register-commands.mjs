import { readFileSync } from "node:fs";

loadVars();
const applicationId=process.env.DISCORD_APPLICATION_ID;
const token=process.env.DISCORD_BOT_TOKEN;
if(!applicationId||!token)throw new Error("需要 DISCORD_APPLICATION_ID 與 DISCORD_BOT_TOKEN");
const command={name:"cuthoo",description:"管理 Cuthoo 商品監控",options:[
  {type:1,name:"subscribe",description:"訂閱授權商品",options:[
    {type:3,name:"url",description:"K-MONSTAR 商品網址",required:true},
    {type:5,name:"authorized",description:"確認已取得網站監控授權",required:true},
    {type:3,name:"name",description:"自訂商品名稱",required:false},
  ]},
  {type:1,name:"list",description:"列出監控商品"},
  {type:1,name:"status",description:"查看商品狀態"},
  {type:1,name:"unsubscribe",description:"停止此頻道的商品訂閱",options:[{type:3,name:"product",description:"商品 ID，例如 c87296443",required:true}]},
]};
const response=await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`,{method:"POST",headers:{authorization:`Bot ${token}`,"content-type":"application/json"},body:JSON.stringify(command)});
if(!response.ok)throw new Error(`Discord ${response.status}: ${await response.text()}`);
console.log("已註冊 /cuthoo 指令");

function loadVars(){try{for(const raw of readFileSync(".dev.vars","utf8").split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith("#"))continue;const i=line.indexOf("=");if(i<=0)continue;const key=line.slice(0,i).trim();let value=line.slice(i+1).trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);if(!process.env[key])process.env[key]=value}}catch(error){if(error.code!=="ENOENT")throw error}}
