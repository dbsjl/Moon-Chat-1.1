(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.MOON_CHAT_CONFIG || {};
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("ВСТАВЬ") && !cfg.SUPABASE_ANON_KEY.includes("ВСТАВЬ");
  let sb = null, user = null, profile = null, activeConversation = null, activePeer = null, messageChannel = null;
  let conversations = [], signupMode = false, toastTimer, realtimeRetry = null;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const initials = (s) => (String(s || "?").trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("") || "?").toUpperCase();
  const toast = (msg) => { const el=$("toast"); if (!el) { console.warn("Moon Chat: элемент toast не найден", msg); return; } el.textContent=msg; el.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),3200); };
  const status = (msg) => { const el=$("authMessage"); if (el) el.textContent=msg; else console.error("Moon Chat: элемент authMessage не найден", msg); };
  const time = (s) => new Date(s).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
  function showAuth(){ $("authView").classList.remove("hidden"); $("appView").classList.add("hidden"); }
  function showApp(){ $("authView").classList.add("hidden"); $("appView").classList.remove("hidden"); }
  function setMode(signup){
    signupMode=signup;
    $("loginTab").classList.toggle("active",!signup);
    $("signupTab").classList.toggle("active",signup);
    $("nameLabel").classList.toggle("hidden",!signup);
    $("displayName").required=signup;
    $("password").autocomplete=signup?"new-password":"current-password";
    $("password").value="";
    $("passwordWarning").classList.toggle("hidden",!signup);
    $("authSubmit").innerHTML=signup?'Создать аккаунт <span>→</span>':'Войти <span>→</span>';
    $("authSubtitle").textContent=signup?'Создай аккаунт с электронной почтой и паролем':'Войди в Moon Chat по почте и паролю';
    status("");
  }
  async function loadProfile(){
    const {data,error}=await sb.from("profiles").select("*").eq("id",user.id).single();
    if(error) throw error; profile=data;
    const name=profile.display_name || user.user_metadata?.display_name || "Пользователь";
    $("myName").textContent=name; $("myId").textContent=profile.public_id; $("myAvatar").textContent=initials(name);
    $("settingsName").textContent=name; $("settingsAvatar").textContent=initials(name); $("settingsId").textContent=profile.public_id; $("settingsEmail").textContent=user.email||"";
  }
  async function enterApp(){
    try { await loadProfile(); showApp(); await loadConversations(); }
    catch(e){ showAuth(); status("Не удалось загрузить профиль: "+e.message); }
  }
  const cacheKey = (kind, id="") => `moonchat:${kind}:${user?.id||"guest"}:${id}`;
  function saveCache(key, value){ try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) { console.warn("Cache save failed", e); } }
  function readCache(key, fallback=null){ try { const raw=localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
  async function loadConversations(){
    // Render the last known list immediately, then refresh it from Supabase.
    const cached = readCache(cacheKey("conversations"));
    if (cached && !conversations.length) { conversations=cached; renderChats(); }
    const {data:members,error}=await sb.from("conversation_members").select("conversation_id").eq("user_id",user.id);
    if(error) throw error;
    const ids=(members||[]).map(x=>x.conversation_id);
    if(!ids.length){conversations=[];saveCache(cacheKey("conversations"),conversations);renderChats();return;}
    const {data:allMembers,error:me}=await sb.from("conversation_members").select("conversation_id,user_id").in("conversation_id",ids);
    if(me) throw me;
    const peers=[...new Set((allMembers||[]).filter(x=>x.user_id!==user.id).map(x=>x.user_id))];
    const {data:profiles,error:pe}=peers.length?await sb.from("profiles").select("id,display_name,public_id").in("id",peers):{data:[],error:null};
    if(pe) throw pe;
    const {data:msgs,error:ms}=await sb.from("messages").select("conversation_id,body,created_at,sender_id").in("conversation_id",ids).order("created_at",{ascending:false}).limit(300);
    if(ms) throw ms;
    conversations=ids.map(id=>{
      const peerId=(allMembers||[]).find(x=>x.conversation_id===id&&x.user_id!==user.id)?.user_id;
      const peer=(profiles||[]).find(x=>x.id===peerId)||{display_name:"Личный чат",public_id:""};
      const last=(msgs||[]).find(x=>x.conversation_id===id);
      return {id,peer,last};
    }).sort((a,b)=>new Date(b.last?.created_at||0)-new Date(a.last?.created_at||0));
    saveCache(cacheKey("conversations"), conversations);
    renderChats();
  }
  function renderChats(){
    const q=$("chatSearch").value.trim().toLowerCase();
    const filtered=conversations.filter(c=>(c.peer.display_name||"").toLowerCase().includes(q)||(c.peer.public_id||"").toLowerCase().includes(q));
    $("chatCount").textContent=conversations.length; $("emptyChats").classList.toggle("hidden",conversations.length>0);
    $("chatList").innerHTML=filtered.map(c=>`<div class="chat-row ${activeConversation===c.id?'selected':''}" data-id="${esc(c.id)}"><div class="avatar">${esc(initials(c.peer.display_name))}</div><div class="chat-meta"><b>${esc(c.peer.display_name)}</b><p>${esc(c.last?.body||c.peer.public_id||"Начните общение")}</p></div><span class="chat-time">${c.last?time(c.last.created_at):""}</span></div>`).join("");
    $("chatList").querySelectorAll(".chat-row").forEach(el=>el.addEventListener("click",()=>openConversation(el.dataset.id)));
  }
  async function openConversation(id){
    const c=conversations.find(x=>x.id===id); if(!c)return;
    activeConversation=id; activePeer=c.peer;
    $("appView").classList.add("mobile-chat-open");
    $("welcomeScreen").classList.add("hidden"); $("conversationView").classList.remove("hidden");
    $("peerName").textContent=c.peer.display_name; $("peerId").textContent=c.peer.public_id; $("peerAvatar").textContent=initials(c.peer.display_name);
    renderChats();
    if(messageChannel) { await sb.removeChannel(messageChannel); messageChannel=null; }
    // Subscribe before loading history so messages sent during the load are not missed.
    messageChannel=sb.channel("messages-"+id+"-"+Date.now())
      .on("postgres_changes",{event:"INSERT",schema:"public",table:"messages",filter:"conversation_id=eq."+id},payload=>{
        if(payload.new.conversation_id===activeConversation) {
          appendMessage(payload.new);
          const cachedMessages=readCache(cacheKey("messages", id), []);
          if(!cachedMessages.some(m=>String(m.id)===String(payload.new.id))) { cachedMessages.push(payload.new); saveCache(cacheKey("messages", id), cachedMessages.slice(-500)); }
        }
        const item=conversations.find(x=>x.id===id); if(item)item.last=payload.new;
        saveCache(cacheKey("conversations"), conversations);
        if(payload.new.sender_id!==user.id && window.MoonChatNative && typeof window.MoonChatNative.notifyMessage === "function") {
          window.MoonChatNative.notifyMessage(String(c.peer.display_name||"Moon Chat"), String(payload.new.body||"Новое сообщение"));
        }
        renderChats();
      })
      .subscribe((state)=>{
        if(state==="CHANNEL_ERROR" || state==="TIMED_OUT") toast("Не удалось подключить обновления сообщений. Проверь Realtime в Supabase.");
      });
    await loadMessages();
  }
  function appendMessage(m){
    if($("messages").querySelector(`[data-message-id="${m.id}"]`))return;
    const el=document.createElement("div"); el.className="message"+(m.sender_id===user.id?" mine":""); el.dataset.messageId=m.id;
    if(m.image_url){
      const link=document.createElement("a"); link.href="#"; link.target="_blank"; link.rel="noopener noreferrer"; link.className="message-photo-link";
      const img=document.createElement("img"); img.alt="Фото"; img.loading="lazy"; img.className="message-photo"; img.src="";
      link.appendChild(img); el.appendChild(link);
      const imagePath=m.image_url;
      const urlPromise=imagePath.startsWith("http")?Promise.resolve(imagePath):sb.storage.from("chat-photos").createSignedUrl(imagePath,3600).then(r=>r.data?.signedUrl);
      urlPromise.then(url=>{if(url){img.src=url;link.href=url;}else img.alt="Не удалось загрузить фото";});
      link.addEventListener("click",e=>{if(!link.href||link.href==="#")e.preventDefault();});
      if(m.body && m.body!=="📷 Фото") { const caption=document.createElement("div"); caption.textContent=m.body; el.appendChild(caption); }
    } else { const body=document.createElement("div"); body.textContent=m.body; el.appendChild(body); }
    const stamp=document.createElement("time"); stamp.textContent=time(m.created_at);
    el.append(stamp); $("messages").appendChild(el); $("messages").scrollTop=$("messages").scrollHeight;
  }
  async function loadMessages(){
    const targetConversation=activeConversation;
    // Show cached messages immediately while the network request runs.
    const cached = readCache(cacheKey("messages", targetConversation), []);
    $("messages").innerHTML="";
    cached.forEach(appendMessage);
    const {data,error}=await sb.from("messages").select("*").eq("conversation_id",targetConversation).order("created_at",{ascending:true}).limit(500);
    if(error){toast("Не удалось загрузить сообщения: "+error.message);return;}
    if(targetConversation!==activeConversation)return;
    saveCache(cacheKey("messages", targetConversation), data||[]);
    (data||[]).forEach(appendMessage);
  }
  async function findUser(rawId){
    const id=rawId.trim().toUpperCase();
    if(!id){$("findResult").textContent="Введи Moon ID.";return;}
    if(profile && id===profile.public_id){$("findResult").textContent="Это твой собственный ID.";return;}
    const {data,error}=await sb.from("profiles").select("id,display_name,public_id").eq("public_id",id).maybeSingle();
    if(error){$("findResult").textContent="Ошибка поиска: "+error.message;return;}
    if(!data){$("findResult").textContent="Пользователь не найден. Проверь ID.";return;}
    $("findResult").innerHTML=`<div class="result-card"><div class="avatar">${esc(initials(data.display_name))}</div><div><b>${esc(data.display_name)}</b><small>${esc(data.public_id)}</small></div><button class="primary" id="startChatBtn">Написать</button></div>`;
    $("startChatBtn").addEventListener("click",()=>startChat(data));
  }
  async function startChat(peer){
    const {data,error}=await sb.rpc("start_direct_chat",{target_user_id:peer.id});
    if(error){toast("Не удалось открыть чат: "+error.message);return;}
    $("findDialog").close();
    await loadConversations();
    const id=typeof data==="string"?data:data?.conversation_id;
    if(id) { if(!conversations.some(c=>c.id===id)) await loadConversations(); await openConversation(id); }
    else { await loadConversations(); const c=conversations.find(x=>x.peer.id===peer.id); if(c)await openConversation(c.id); }
  }
  $("loginTab").addEventListener("click",()=>setMode(false));
  $("signupTab").addEventListener("click",()=>setMode(true));
  $("loginTab").addEventListener("click",()=>setMode(false));
  $("signupTab").addEventListener("click",()=>setMode(true));
  $("authForm").addEventListener("submit",async e=>{
    e.preventDefault();
    if(!configured){status("Не настроено подключение к Supabase.");return;}
    if(!sb){status("Подключение Supabase не готово. Обнови страницу и попробуй снова.");return;}
    const email=$("email").value.trim();
    const password=$("password").value;
    const displayName=$("displayName").value.trim();
    if(!email){status("Введи адрес электронной почты.");$("email").focus();return;}
    if(password.length<6){status("Пароль должен содержать минимум 6 символов.");$("password").focus();return;}
    if(signupMode && displayName.length<2){status("Имя должно содержать минимум 2 символа.");$("displayName").focus();return;}
    $("authSubmit").disabled=true;
    status(signupMode?"Создаём аккаунт…":"Выполняем вход…");
    try{
      if(signupMode){
        const {data,error}=await sb.auth.signUp({email,password,options:{data:{display_name:displayName},emailRedirectTo:location.origin}});
        if(error)throw error;
        if(data.session){user=data.user;await enterApp();}
        else status("Аккаунт создан, но Supabase требует подтверждение почты. Чтобы вход был сразу без кода/ссылки, отключи Confirm email в настройках Supabase Auth.");
      }else{
        const {data,error}=await sb.auth.signInWithPassword({email,password});
        if(error)throw error;
        user=data.user; await enterApp();
      }
    }catch(err){
      const message=err?.message||"Не удалось выполнить вход.";
      if(/invalid login credentials/i.test(message)) status("Неверная почта или пароль. Если аккаунта ещё нет, выбери «Создать аккаунт».");
      else if(/email not confirmed/i.test(message)) status("Почта ещё не подтверждена. Найди письмо от Supabase и нажми ссылку подтверждения.");
      else if(/rate limit|too many requests/i.test(message)) status("Supabase временно ограничил отправку писем. Подожди перед новой попыткой.");
      else status(message);
    }finally{$("authSubmit").disabled=false;}
  });
  async function logout(){
    try {
      const {error}=await sb.auth.signOut(); if(error)throw error;
      user=null;profile=null;activeConversation=null;conversations=[];
      if(messageChannel){await sb.removeChannel(messageChannel);messageChannel=null;}
      $("appView").classList.remove("mobile-chat-open"); showAuth(); setMode(false); toast("Вы вышли из аккаунта");
    } catch(e){toast("Не удалось выйти: "+(e.message||"проверь подключение"));}
  }
  $("logoutBtn").addEventListener("click",logout);
  $("userSettingsBtn").addEventListener("click",()=>$("settingsDialog").showModal());
  $("mobileSettingsBtn").addEventListener("click",()=>$("settingsDialog").showModal());
  $("settingsCopyId").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(profile.public_id);toast("Moon ID скопирован");}catch{toast(profile.public_id);}});
  $("mobileBack").addEventListener("click",()=>$("appView").classList.remove("mobile-chat-open"));
  const openFind=()=>{$("findResult").textContent="";$("findId").value="";$("findDialog").showModal();};
  $("newChatBtn").addEventListener("click",openFind); $("emptyFindBtn").addEventListener("click",openFind); $("welcomeFindBtn").addEventListener("click",openFind); $("contactsNav").addEventListener("click",openFind);
  $("findForm").addEventListener("submit",e=>{e.preventDefault();findUser($("findId").value);});
  $("chatSearch").addEventListener("input",renderChats);
  $("messageForm").addEventListener("submit",async e=>{
    e.preventDefault(); const body=$("messageInput").value.trim();if(!body||!activeConversation)return;
    $("messageInput").value="";
    const {data,error}=await sb.from("messages").insert({conversation_id:activeConversation,sender_id:user.id,body}).select().single();
    if(error){$("messageInput").value=body;toast("Сообщение не отправлено: "+error.message);return;}
    appendMessage(data);
    const item=conversations.find(x=>x.id===activeConversation); if(item)item.last=data;
    renderChats();
  });
  $("photoInput").addEventListener("change",async e=>{
    const file=e.target.files?.[0]; e.target.value=""; if(!file)return;
    if(!activeConversation){toast("Сначала открой чат");return;}
    if(!file.type.startsWith("image/")){toast("Выбери файл изображения");return;}
    if(file.size>8*1024*1024){toast("Фото должно быть меньше 8 МБ");return;}
    const safeName=file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const path=`${user.id}/${Date.now()}-${safeName}`;
    toast("Отправляем фото…");
    const {error:uploadError}=await sb.storage.from("chat-photos").upload(path,file,{contentType:file.type,upsert:false});
    if(uploadError){toast("Не удалось загрузить фото: "+uploadError.message);return;}
    const {data,error}=await sb.from("messages").insert({conversation_id:activeConversation,sender_id:user.id,body:"📷 Фото",image_url:path}).select().single();
    if(error){toast("Фото загружено, но сообщение не отправлено: "+error.message);return;}
    appendMessage(data); const cachedMessages=readCache(cacheKey("messages", activeConversation), []); cachedMessages.push(data); saveCache(cacheKey("messages", activeConversation), cachedMessages.slice(-500)); const item=conversations.find(x=>x.id===activeConversation);if(item)item.last=data;saveCache(cacheKey("conversations"),conversations);renderChats();toast("Фото отправлено");
  });
  $("refreshBtn").addEventListener("click",async()=>{await loadMessages();await loadConversations();toast("Обновлено");});
  $("chatsNav").addEventListener("click",()=>{ $("appView").classList.remove("mobile-chat-open"); $("chatsNav").classList.add("active"); });
  if(configured && window.supabase && typeof window.supabase.createClient === "function"){
    sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
    sb.auth.getSession().then(async({data})=>{if(data.session){user=data.session.user;await enterApp();}else showAuth();});
    sb.auth.onAuthStateChange((_event,session)=>{if(session&&!user){user=session.user;setTimeout(enterApp,0);}});
  }else{
    showAuth();
    if (!configured) status("Настройка: добавь URL и Publishable key Supabase в config.js. Подробности — в README.");
    else status("Не загрузилась библиотека Supabase. Проверь интернет и обнови страницу; если ошибка повторится, попробуй открыть сайт позже.");
  }
})();