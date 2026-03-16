// --- Config ---
const OLLAMA_SERVER = 'http://localhost:8000';
const API_URL = 'http://localhost:8000'; 
const MODEL_MULTIMODAL = 'amsaravi/medgemma-4b-it:q8'; 
const MODEL_TEXT_ONLY = 'amsaravi/medgemma-4b-it:q8';
let DEFAULT_SYMPTOM_PROMPT = `[SYSTEM MESSAGE: STRICT SINGLE-TURN INTERVIEW PROTOCOL]
คุณคือผู้ช่วยแพทย์ AI หน้าที่ของคุณคือการซักประวัติผู้ป่วยทีละขั้นตอน

กฎเหล็ก 3 ข้อ (CRITICAL INSTRUCTIONS):
1. **ห้ามพิมพ์เป็นข้อๆ (No Bullet Points)** - คุณต้องถามคำถามเพียง 1 ประโยคถ้วนต่อการตอบ 1 ครั้ง
2. **ห้ามรวบคำถาม** - ให้ถามแค่ 1 ประเด็น (เช่น ถามแค่ตำแหน่ง หรือ ถามแค่ความเจ็บปวด ห้ามถามรวมกัน)
3. **ต้องลงท้ายด้วยเครื่องหมายคำถาม (?) เสมอ** ยกเว้นตอนสรุปอาการ

ตัวอย่างการทำงานที่ถูกต้อง:
AI: สวัสดีครับ มีอาการอะไรให้ผมช่วยดูแลครับ?
ผู้ป่วย: ปวดหัวครับ
AI: ปวดหัวบริเวณไหนครับ? (ถาม 1 ข้อ)
ผู้ป่วย: ปวดขมับขวา
AI: อาการปวดเป็นแบบไหนครับ ปวดตุบๆ หรือปวดตื้อๆ? (ถาม 1 ข้อ)

เมื่อคุณถามไปแล้ว 5-6 คำถาม และได้ข้อมูลครบถ้วนพอสมควรแล้ว:
ให้คุณหยุดถาม และพิมพ์ข้อความตามรูปแบบด้านล่างนี้เป๊ะๆ:
---สิ้นสุดการซักประวัติ---
**1. สรุปข้อมูลผู้ป่วยหลัก:**
(สรุปอาการทั้งหมด)
**2. การประเมินโรคเบื้องต้น (Impression):**
(วิเคราะห์โรค 2-3 โรค)
**3. คำแนะนำเบื้องต้น:**
(คำแนะนำการปฏิบัติตัว)`;

let DEFAULT_VISION_PROMPT = `คุณคือผู้เชี่ยวชาญด้านรังสีวิทยาและการแพทย์ กรุณาวิเคราะห์รูปภาพที่ได้รับอย่างละเอียด
1. ตอบเป็น **ภาษาไทย** เท่านั้น
2. วินิจฉัยโรคที่น่าจะเป็น (Impression)
3. แนะนำการตรวจเพิ่มเติมถ้าจำเป็น`;

let SYMPTOM_PROMPT = localStorage.getItem('symptom_prompt') || DEFAULT_SYMPTOM_PROMPT;
let VISION_PROMPT = localStorage.getItem('vision_prompt') || DEFAULT_VISION_PROMPT;

// --- DOM Elements ---
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const historyEl = document.getElementById('history');
const recentListEl = document.getElementById('recent-list');
const fileInput = document.getElementById('file-input');
const fileInputLabel = document.getElementById('file-input-label');
const previewsEl = document.getElementById('previews');
const btnMic = document.getElementById('btn-mic');
const btnVoiceMode = document.getElementById('btn-voice-mode');
const chatPanel = document.getElementById('chat-panel');
const landingView = document.getElementById('landing-view');
const profileView = document.getElementById('profile-view');
const settingsView = document.getElementById('settings-view');
const toggleBtn = document.getElementById('btn-toggle-sidebar');

// Auth & Profile Elements
const authOverlay = document.getElementById('auth-overlay');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const profileTrigger = document.getElementById('profile-trigger');
const dropdownMenu = document.getElementById('dropdown-menu');
const currentUserNameEl = document.getElementById('current-user-name');
const menuUserNameEl = document.getElementById('menu-user-name');
const logoutBtnMenu = document.getElementById('logout-btn-menu');
const themeToggleMenu = document.getElementById('theme-toggle-menu');

let allChats = {}; 
let currentChatId = null;
let currentChatType = 'multimodal'; 
let recognition;
let synth = window.speechSynthesis;
let isRecording = false;
let isVoiceModeOn = false; 
let autoListening = false;
let thaiVoice = null;
let silenceTimer = null; // To automatically stop/send after silence in voice mode

// --- Helper Functions ---
async function authFetch(url, options = {}) {
    const token = localStorage.getItem('access_token');
    if (!token) return null;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options.headers
    };
    try {
        const res = await fetch(`${API_URL}${url}`, { ...options, headers });
        if (res.status === 401) { logout(); return null; }
        return res;
    } catch (err) { console.error("API Error:", err); return null; }
}

function updateSendButtonState() {
    const text = promptEl.value.trim();
    const hasImages = previewsEl && previewsEl.children.length > 0;
    
    if (text.length > 0 || hasImages) {
        sendBtn.removeAttribute('disabled');
        sendBtn.classList.add('enabled');
    } else {
        sendBtn.setAttribute('disabled', 'true');
        sendBtn.classList.remove('enabled');
    }
}

// --- Auth Logic ---
async function checkAuth() {
    const token = localStorage.getItem('access_token');
    const username = localStorage.getItem('username');
    if (token) {
        // Fetch real profile data instead of just trusting username from localStorage
        const res = await authFetch('/api/auth/me');
        if (res && res.ok) {
            const data = await res.json();
            authOverlay.classList.add('hidden');
            const displayName = data.full_name || data.username;
            if(currentUserNameEl) currentUserNameEl.textContent = displayName;
            if(menuUserNameEl) menuUserNameEl.textContent = displayName;
            // Store role globally if needed
            window.currentUserRole = data.role;
            syncChats();
            
            // Fetch profile for avatar
            try {
                const profileRes = await authFetch('/api/profile');
                if (profileRes && profileRes.ok) {
                    const pData = await profileRes.json();
                    if (pData.profile_picture_url) {
                        currentUploadedProfilePic = pData.profile_picture_url;
                        updateDropdownAvatar(pData.profile_picture_url);
                    }
                }
            } catch (e) {}

            return;
        }
    }
    // If no token or fetch failed, show login
    authOverlay.classList.remove('hidden');
}

function toggleAuthMode(mode) {
    loginForm.classList.add('hidden');
    registerForm.classList.add('hidden');
    document.getElementById('otp-form').classList.add('hidden');

    if (mode === 'register') {
        registerForm.classList.remove('hidden');
    } else if (mode === 'otp') {
        document.getElementById('otp-form').classList.remove('hidden');
    } else {
        loginForm.classList.remove('hidden');
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById('login-user').value;
    const pass = document.getElementById('login-pass').value;
    const submitBtn = e.target.querySelector('button');
    const originalBtnText = submitBtn.innerText;
    
    submitBtn.innerText = "กำลังเข้าสู่ระบบ...";
    submitBtn.disabled = true;

    try {
        const res = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });
        const data = await res.json();
        if (res.ok) {
            localStorage.setItem('access_token', data.access_token);
            localStorage.setItem('username', data.username);
            document.getElementById('login-user').value = '';
            document.getElementById('login-pass').value = '';
            await checkAuth(); // Re-fetch profile data
        } else {
            alert(data.detail || 'เข้าสู่ระบบไม่สำเร็จ');
        }
    } catch (err) {
        alert('เชื่อมต่อ Server ไม่ได้ (เปิด server.py หรือยัง?)');
    } finally {
        submitBtn.innerText = originalBtnText;
        submitBtn.disabled = false;
    }
}

let currentOtpEmail = "";

async function handleRegister(e) {
    e.preventDefault();
    const user = document.getElementById('reg-user').value;
    const pass = document.getElementById('reg-pass').value;
    const confirmPass = document.getElementById('reg-pass-confirm').value;
    const email = document.getElementById('reg-email').value;

    if (pass !== confirmPass) { alert("รหัสผ่านไม่ตรงกัน"); return; }
    const submitBtn = e.target.querySelector('button');
    submitBtn.innerText = "กำลังบันทึกและส่งรหัส...";
    submitBtn.disabled = true;

    try {
        const res = await fetch(`${API_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                username: user, 
                password: pass,
                email: email
            })
        });
        const data = await res.json();
        if (res.ok) {
            alert('สมัครสมาชิกสำเร็จ! กรุณาตรวจสอบรหัส OTP ในกล่องจดหมายอีเมลของคุณ');
            currentOtpEmail = email; // Store for verification step
            document.getElementById('otp-email-desc').textContent = `ส่งรหัสไปยัง: ${email}`;
            toggleAuthMode('otp');
        } else {
            alert(data.detail || 'สมัครสมาชิกไม่สำเร็จ');
        }
    } catch (err) {
        alert('เชื่อมต่อ Server ไม่ได้');
    } finally {
        submitBtn.innerText = "สมัครสมาชิก";
        submitBtn.disabled = false;
    }
}

async function handleVerifyOTP(e) {
    e.preventDefault();
    const otpCode = document.getElementById('otp-code').value;
    if (!otpCode || otpCode.length !== 6) return alert('กรอกรหัส 6 หลักให้ครบถ้วน');
    
    const submitBtn = e.target.querySelector('button');
    submitBtn.innerText = "กำลังตรวจสอบ...";
    submitBtn.disabled = true;
    
    try {
        const res = await fetch(`${API_URL}/api/auth/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentOtpEmail, otp_code: otpCode })
        });
        const data = await res.json();
        if (res.ok) {
            alert('ยืนยันตัวตนสำเร็จ! ตอนนี้คุณสามารถเข้าสู่ระบบได้แล้ว');
            toggleAuthMode('login');
            document.getElementById('login-user').focus();
        } else {
            alert(data.detail || 'รหัส OTP ไม่ถูกต้อง');
        }
    } catch (err) {
        alert('เชื่อมต่อ Server ไม่ได้');
    } finally {
        submitBtn.innerText = "ยืนยันรหัส";
        submitBtn.disabled = false;
    }
}

function logout() {
    localStorage.removeItem('access_token');
    localStorage.removeItem('username');
    location.reload(); 
}

// --- Database Logic ---
async function syncChats() {
    const res = await authFetch('/api/chats');
    if (res && res.ok) {
        allChats = await res.json() || {};
        renderRecentList();
    }
}

async function saveCurrentChat() {
    if (!currentChatId || !allChats[currentChatId]) return;
    const chatData = allChats[currentChatId];
    
    if (chatData.isNewToServer) {
        const res = await authFetch('/api/chats', {
            method: 'POST',
            body: JSON.stringify({ ...chatData, id: currentChatId })
        });
        if (res && res.ok) chatData.isNewToServer = false;
    } else {
        await authFetch(`/api/chats/${currentChatId}`, {
            method: 'PUT',
            body: JSON.stringify({ ...chatData, id: currentChatId })
        });
    }
}

window.deleteChat = async (id) => {
    if(!confirm('ลบแชทนี้?')) return;
    const res = await authFetch(`/api/chats/${id}`, { method: 'DELETE' });
    if (res && (res.ok || res.status === 404)) {
        delete allChats[id];
        if (currentChatId === id) showLandingPage();
        else renderRecentList();
    } else {
        alert('เกิดข้อผิดพลาดในการลบ');
    }
}

// --- Chat Core Logic ---
function startChat(type) {
    if(synth.speaking) synth.cancel();

    // ลบแชทเปล่าก่อนหน้า
    if (currentChatId && allChats[currentChatId] && allChats[currentChatId].messages.length <= 1) {
        delete allChats[currentChatId];
    }

    currentChatType = type;
    currentChatId = Date.now().toString(); 
    
    landingView.classList.add('hidden');
    if (profileView) profileView.classList.add('hidden');
    if (settingsView) settingsView.classList.add('hidden');
    chatPanel.classList.remove('hidden');
    historyEl.innerHTML = ''; 
    promptEl.value = ''; 
    promptEl.style.height = '40px'; // Reset height
    previewsEl.innerHTML = '';
    updateSendButtonState();
    
    updateUI(type);
    let firstMsg = type === 'multimodal' ? 'สวัสดีครับ เชิญแนบรูปภาพหรือบอกอาการได้เลยครับ' : 'สวัสดีครับ ผมคือ AI ช่วยซักประวัติ กรุณาเล่าอาการของคุณครับ';
    
    addMessage('assistant', firstMsg);
    
    allChats[currentChatId] = { 
        id: currentChatId,
        title: type === 'multimodal' ? 'แชทวิเคราะห์' : 'ซักประวัติผู้ป่วย', 
        type: type, 
        messages: [{ role: 'assistant', content: firstMsg }],
        isNewToServer: true
    };
    
    renderRecentList(); 
    if(isVoiceModeOn) speak(firstMsg);
}

function loadChat(id) {
    if (!allChats[id]) return;
    
    // Lazy load messages if they aren't loaded yet
    if (!allChats[id].messages || allChats[id].messages.length === 0) {
        authFetch(`/api/chats/${id}`).then(async (res) => {
            if (res && res.ok) {
                const fullChat = await res.json();
                allChats[id].messages = fullChat.messages || [];
                renderChatContent(id);
            } else {
                alert('ไม่สามารถโหลดประวัติแชทได้');
            }
        });
    } else {
        renderChatContent(id);
    }
}

function renderChatContent(id) {
    landingView.classList.add('hidden');
    if (profileView) profileView.classList.add('hidden');
    if (settingsView) settingsView.classList.add('hidden');
    chatPanel.classList.remove('hidden');
    currentChatId = id;
    const chat = allChats[id];
    currentChatType = chat.type;
    historyEl.innerHTML = '';
    updateUI(chat.type);
    chat.messages.forEach(m => addMessage(m.role, m.content, m.images));
    scrollToBottom();
    renderRecentList();
}

function updateUI(type) {
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    if (type === 'multimodal') {
        document.getElementById('new-chat-multimodal')?.classList.add('active');
        fileInputLabel.classList.remove('hidden');
        previewsEl.classList.remove('hidden');
    } else {
        document.getElementById('new-chat-symptom')?.classList.add('active');
        fileInputLabel.classList.add('hidden');
        previewsEl.classList.add('hidden');
    }
}

async function handleSend() {
    if (synth.speaking) { synth.cancel(); return; }
    if (recognition) recognition.stop();
    isRecording = false; 

    const text = promptEl.value.trim();
    const images = Array.from(previewsEl.querySelectorAll('img')).map(i => i.src);
    if (!text && images.length === 0) return;

    addMessage('user', text, images);
    const userMsgData = { role: 'user', content: text, images: images };
    
    if(!allChats[currentChatId]) startChat(currentChatType);
    allChats[currentChatId].messages.push(userMsgData);
    await saveCurrentChat(); 

    // Reset UI
    promptEl.value = ''; 
    promptEl.style.height = '40px';
    previewsEl.innerHTML = ''; 
    updateSendButtonState();
    
    addPlaceholder();

    try {
        const historyMessages = allChats[currentChatId].messages.map(m => {
            const msgObj = { role: m.role, content: m.content };
            if (m.images?.length > 0) {
                msgObj.images = m.images.map(img => img.startsWith('data:') ? img.split(',')[1] : img);
            }
            return msgObj;
        });

        let systemInstruction = currentChatType === 'multimodal' ? VISION_PROMPT : SYMPTOM_PROMPT;
        const finalMessages = [{ role: 'system', content: systemInstruction }, ...historyMessages];
        
        const modelToUse = currentChatType === 'multimodal' ? MODEL_MULTIMODAL : MODEL_TEXT_ONLY;

        const res = await fetch(`${API_URL}/api/chat`, { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({ model: modelToUse, messages: finalMessages }) 
        });
        
        const data = await res.json();
        removePlaceholder();
        const aiResponse = data.message?.content || "ขออภัย ระบบไม่ได้รับคำตอบ";
        
        addMessage('assistant', aiResponse);
        allChats[currentChatId].messages.push({ role: 'assistant', content: aiResponse });
        await saveCurrentChat();

        if (isVoiceModeOn) speak(aiResponse);
    } catch (err) {
        removePlaceholder(); 
        addMessage('assistant', `เกิดข้อผิดพลาด: ${err.message}`); 
    }
}

// --- UI Utilities ---
function addMessage(role, text, images = []) {
    const msgDiv = document.createElement('div'); 
    msgDiv.className = `message ${role}`;
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    
    if(images.length > 0) {
        images.forEach(src => { 
            const img = document.createElement('img'); img.src = src; bubble.appendChild(img); 
        });
    }
    bubble.innerHTML += text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    const avatar = document.createElement('div'); avatar.className = 'avatar';
    avatar.innerHTML = role === 'user' ? '<span class="material-icons">person</span>' : '<span class="material-icons">smart_toy</span>';
    
    if (role === 'user') { msgDiv.appendChild(bubble); msgDiv.appendChild(avatar); } 
    else { msgDiv.appendChild(avatar); msgDiv.appendChild(bubble); }
    historyEl.appendChild(msgDiv); scrollToBottom();
}

function addPlaceholder() {
    const div = document.createElement('div'); div.id = 'placeholder'; div.className = 'message assistant';
    div.innerHTML = `<div class="avatar"><span class="material-icons">smart_toy</span></div><div class="bubble"><div class="spinner"></div></div>`;
    historyEl.appendChild(div); scrollToBottom();
}
function removePlaceholder() { document.getElementById('placeholder')?.remove(); }
function scrollToBottom() { historyEl.scrollTop = historyEl.scrollHeight; }

function renderRecentList() {
    recentListEl.innerHTML = '';
    Object.keys(allChats).sort().reverse().forEach(id => {
        const chat = allChats[id];
        const div = document.createElement('div');
        div.className = `recent-chat-btn ${id === currentChatId ? 'active' : ''}`;
        div.innerHTML = `<div class="recent-chat-title" onclick="loadChat('${id}')"><span class="material-icons" style="font-size:16px">${chat.type === 'multimodal' ? 'image' : 'edit_note'}</span> ${chat.title}</div><button class="delete-chat-btn" onclick="deleteChat('${id}')"><span class="material-icons" style="font-size:16px">close</span></button>`;
        recentListEl.appendChild(div);
    });
}

function showLandingPage() {
    window.location.hash = '#/';
}

function _showLandingView() {
    if (currentChatId && allChats[currentChatId]) {
        if (allChats[currentChatId].messages.length <= 1) {
            delete allChats[currentChatId];
        }
    }
    chatPanel.classList.add('hidden');
    if (profileView) profileView.classList.add('hidden');
    if (settingsView) settingsView.classList.add('hidden');
    landingView.classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    currentChatId = null;
    renderRecentList();
    if(window.innerWidth <= 900) document.querySelector('.app').classList.remove('sidebar-open');
}

async function showProfilePage() {
    window.location.hash = '#/profile';
}

async function _renderProfileView() {
    landingView.classList.add('hidden');
    chatPanel.classList.add('hidden');
    if (settingsView) settingsView.classList.add('hidden');
    if (profileView) profileView.classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('nav-profile-btn')?.classList.add('active');
    currentChatId = null;
    
    const username = document.getElementById('current-user-name').textContent || 'Unknown User';
    const role = window.currentUserRole || 'user';
    
    const profilePageUsername = document.getElementById('profile-page-username');
    const profileRole = document.querySelector('.profile-role');
    
    if (profilePageUsername) profilePageUsername.textContent = username;
    if (profileRole) profileRole.textContent = `ระดับสิทธิ์: ${role.toUpperCase()}`;
    
    try {
        const res = await fetch(`${API_URL}/api/profile`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` }
        });
        if (res.ok) {
            const data = await res.json();
            document.getElementById('profile-firstname').value = data.first_name || '';
            document.getElementById('profile-lastname').value = data.last_name || '';
            document.getElementById('profile-phone').value = data.phone || '';
            document.getElementById('profile-bio').value = data.bio || '';
            
            const avatarPreview = document.getElementById('profile-pic-preview');
            const avatarIcon = document.getElementById('profile-pic-icon');
            if (data.profile_picture_url) {
                currentUploadedProfilePic = data.profile_picture_url;
                avatarPreview.src = data.profile_picture_url;
                avatarPreview.style.display = 'block';
                avatarIcon.style.display = 'none';
                updateDropdownAvatar(data.profile_picture_url);
            } else {
                avatarPreview.style.display = 'none';
                avatarIcon.style.display = 'block';
                updateDropdownAvatar(null);
            }
        }
    } catch (err) { console.error('Error fetching profile:', err); }
}

async function showSettingsPage() {
    window.location.hash = '#/settings';
}

async function _renderSettingsView() {
    landingView.classList.add('hidden');
    chatPanel.classList.add('hidden');
    if (profileView) profileView.classList.add('hidden');
    if (settingsView) settingsView.classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('nav-settings-btn')?.classList.add('active');
    currentChatId = null;

    const settingSymptomPrompt = document.getElementById('setting-symptom-prompt');
    const settingVisionPrompt = document.getElementById('setting-vision-prompt');
    
    try {
        const res = await fetch(`${API_URL}/api/prompts`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` }
        });
        if (res.ok) {
            const data = await res.json();
            if (data.symptom_prompt) SYMPTOM_PROMPT = data.symptom_prompt;
            else SYMPTOM_PROMPT = DEFAULT_SYMPTOM_PROMPT;
            if (data.vision_prompt) VISION_PROMPT = data.vision_prompt;
            else VISION_PROMPT = DEFAULT_VISION_PROMPT;
        }
    } catch (err) { console.error('Error fetching prompts:', err); }

    if (settingSymptomPrompt) settingSymptomPrompt.value = SYMPTOM_PROMPT;
    if (settingVisionPrompt) settingVisionPrompt.value = VISION_PROMPT;

    if (dropdownMenu) dropdownMenu.classList.remove('show');
}

async function savePrompts() {
    const settingSymptomPrompt = document.getElementById('setting-symptom-prompt');
    const settingVisionPrompt = document.getElementById('setting-vision-prompt');
    
    if (settingSymptomPrompt && settingVisionPrompt) {
        SYMPTOM_PROMPT = settingSymptomPrompt.value.trim() || DEFAULT_SYMPTOM_PROMPT;
        VISION_PROMPT = settingVisionPrompt.value.trim() || DEFAULT_VISION_PROMPT;
        
        try {
            const res = await fetch(`${API_URL}/api/prompts`, {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('access_token')}` 
                },
                body: JSON.stringify({
                    symptom_prompt: SYMPTOM_PROMPT,
                    vision_prompt: VISION_PROMPT
                })
            });
            if (res.ok) {
                alert("บันทึก Prompt สำเร็จ");
                window.location.reload();
            }
            else alert("บันทึกไม่สำเร็จ");
        } catch(err) {
            alert("เชื่อมต่อ Server ไม่ได้");
        }
    }
}

function resetPrompts() {
    if(!confirm("ต้องการคืนค่า Prompt กลับเป็นค่าเริ่มต้นหรือไม่?")) return;
    
    const settingSymptomPrompt = document.getElementById('setting-symptom-prompt');
    const settingVisionPrompt = document.getElementById('setting-vision-prompt');
    
    if (settingSymptomPrompt && settingVisionPrompt) {
        settingSymptomPrompt.value = DEFAULT_SYMPTOM_PROMPT;
        settingVisionPrompt.value = DEFAULT_VISION_PROMPT;
        savePrompts();
    }
}

let currentUploadedProfilePic = null;

function updateDropdownAvatar(src) {
    const avatarImg = document.getElementById('dropdown-avatar-img');
    const avatarIcon = document.getElementById('dropdown-avatar-icon');
    if (!avatarImg || !avatarIcon) return;
    if (src) {
        avatarImg.src = src;
        avatarImg.style.display = 'block';
        avatarIcon.style.display = 'none';
    } else {
        avatarImg.style.display = 'none';
        avatarIcon.style.display = 'block';
    }
}

function handleProfilePicChange(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            currentUploadedProfilePic = e.target.result;
            const preview = document.getElementById('profile-pic-preview');
            const icon = document.getElementById('profile-pic-icon');
            preview.src = currentUploadedProfilePic;
            preview.style.display = 'block';
            icon.style.display = 'none';
            // Sync dropdown avatar in real time
            updateDropdownAvatar(currentUploadedProfilePic);
        };
        reader.readAsDataURL(file);
    }
}

async function saveProfile() {
    const first_name = document.getElementById('profile-firstname').value;
    const last_name = document.getElementById('profile-lastname').value;
    const phone = document.getElementById('profile-phone').value;
    const bio = document.getElementById('profile-bio').value;
    
    try {
        const res = await fetch(`${API_URL}/api/profile`, {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('access_token')}` 
            },
            body: JSON.stringify({
                first_name: first_name || null,
                last_name: last_name || null,
                phone: phone || null,
                bio: bio || null,
                profile_picture_url: currentUploadedProfilePic || undefined
            })
        });
        if (res.ok) {
            alert('บันทึกข้อมูลส่วนตัวเรียบร้อยแล้ว');
            window.location.reload();
        }
        else alert('เกิดข้อผิดพลาดในการบันทึกข้อมูล');
    } catch(err) {
        alert('เชื่อมต่อ Server ไม่ได้');
    }
}

// --- Voice & Init (Upgraded) ---
function loadThaiVoice() {
    let voices = synth.getVoices();
    // Try to find the best Thai voice, particularly Google's
    thaiVoice = voices.find(v => v.lang === 'th-TH' && v.name.includes('Google')) || 
                voices.find(v => v.lang === 'th-TH') || 
                voices.find(v => v.lang.startsWith('th'));
}

if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = loadThaiVoice;
}

function initVoice() {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        
        recognition.lang = 'th-TH'; 
        recognition.continuous = true; // Use continuous so it doesn't cut off easily
        recognition.interimResults = true; // Show results while talking
        
        recognition.onstart = () => { 
            isRecording = true; 
            btnMic.classList.add('listening'); 
        };
        
        recognition.onresult = (e) => { 
            let interimTranscript = '';
            let finalTranscript = '';
            
            for (let i = e.resultIndex; i < e.results.length; ++i) {
                if (e.results[i].isFinal) {
                    finalTranscript += e.results[i][0].transcript;
                } else {
                    interimTranscript += e.results[i][0].transcript;
                }
            }
            
            // Build the string
            if (finalTranscript || interimTranscript) {
                promptEl.value = finalTranscript + interimTranscript;
                updateSendButtonState();
            }

            // If in continuous Voice Mode, auto-send after a pause
            if (isVoiceModeOn) {
                clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                    if (promptEl.value.trim() !== "") {
                        recognition.stop();
                        handleSend();
                    }
                }, 1500); // 1.5 seconds of silence triggers send
            }
        };

        recognition.onerror = (e) => {
            console.error('Speech recognition error', e.error);
            if(e.error === 'no-speech' && isVoiceModeOn && !synth.speaking) {
                // If it timed out but we are in continuous mode, restart
                try { recognition.start(); } catch(err){}
            }
        };

        recognition.onend = () => { 
            isRecording = false; 
            btnMic.classList.remove('listening'); 
            // Restart if we are in voice mode and the system is not speaking
            if(isVoiceModeOn && !synth.speaking) {
                try { recognition.start(); } catch(err){}
            }
        };
    } else {
        console.warn("Speech Recognition not supported in this browser.");
        btnMic.style.display = 'none';
        btnVoiceMode.style.display = 'none';
    }
}

function speak(text) {
    if (synth.speaking) {
        synth.cancel();
    }
    
    // Remove markdown formatting symbols for speech
    const cleanText = text.replace(/[*_#`~]+/g, '').replace(/---/g, '');
    
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'th-TH';
    
    // Optimize speech parameters to sound less robotic
    utterance.rate = 1.05; // Slightly faster than default
    utterance.pitch = 1.1; // Slightly higher pitch
    
    if (!thaiVoice) loadThaiVoice();
    if (thaiVoice) utterance.voice = thaiVoice;
    
    utterance.onend = () => { 
        // Once AI finishes speaking, open mic again if in voice loop mode
        if(isVoiceModeOn) {
            promptEl.value = ''; // Clean prompt
            try { recognition.start(); } catch(e){}
        }
    };
    
    utterance.onerror = (e) => {
        console.error('Speech synthesis error', e);
        if(isVoiceModeOn) {
            try { recognition.start(); } catch(err){}
        }
    }
    
    synth.speak(utterance);
}

// --- Event Listeners ---
if (loginForm) loginForm.addEventListener('submit', handleLogin);
if (registerForm) registerForm.addEventListener('submit', handleRegister);
const otpForm = document.getElementById('otp-form');
if (otpForm) otpForm.addEventListener('submit', handleVerifyOTP);
if (logoutBtnMenu) logoutBtnMenu.addEventListener('click', logout);
if(sendBtn) sendBtn.onclick = handleSend;
if(btnMic) btnMic.onclick = () => isRecording ? recognition.stop() : recognition.start();
if(btnVoiceMode) btnVoiceMode.onclick = () => { isVoiceModeOn = !isVoiceModeOn; btnVoiceMode.classList.toggle('voice-active'); if(isVoiceModeOn) recognition.start(); else recognition.stop(); };
if (toggleBtn) toggleBtn.onclick = () => document.querySelector('.app').classList.toggle('sidebar-collapsed');

// Mobile Overlay Click to Close Sidebar
document.addEventListener('click', (e) => {
    const appElement = document.querySelector('.app');
    const sidebar = document.querySelector('.sidebar');
    const mobileBtn = document.getElementById('mobile-menu-btn');
    
    // Check if we are on mobile (sidebar is fixed via media query)
    if (window.innerWidth <= 900 && appElement.classList.contains('sidebar-open')) {
        // If click is outside sidebar and NOT the toggle switch itself
        if (sidebar && !sidebar.contains(e.target) && mobileBtn && !mobileBtn.contains(e.target)) {
            appElement.classList.remove('sidebar-open');
        }
    }
});

// Auto-resize Prompt & Button State
promptEl.addEventListener('input', function() {
    this.style.height = '40px'; 
    this.style.height = (this.scrollHeight) + 'px';
    if (this.value.trim() !== "") this.classList.add('scroll-active');
    else this.classList.remove('scroll-active');
    updateSendButtonState();
});

promptEl.addEventListener('keydown', (e) => { 
    if (e.key === 'Enter' && !e.shiftKey) { 
        e.preventDefault(); 
        handleSend(); 
    } 
});

if (profileTrigger) profileTrigger.onclick = (e) => { e.stopPropagation(); dropdownMenu.classList.toggle('show'); };
document.onclick = (e) => { if (dropdownMenu && !dropdownMenu.contains(e.target) && !profileTrigger.contains(e.target)) dropdownMenu.classList.remove('show'); };

const brandLogo = document.getElementById('brand-logo');
if (brandLogo) brandLogo.addEventListener('click', showLandingPage);

// Watch for file additions
fileInput.addEventListener('change', (e) => {
    Array.from(e.target.files).forEach(f => {
        const r = new FileReader(); 
        r.onload = (ev) => { 
            previewsEl.innerHTML += `<div class="preview"><img src="${ev.target.result}"><div class="rm" onclick="this.parentElement.remove()">✕</div></div>`; 
        }; 
        r.readAsDataURL(f);
    });
});

// Watch for file removals (MutationObserver)
const observer = new MutationObserver(() => {
    updateSendButtonState();
});
if(previewsEl) {
    observer.observe(previewsEl, { childList: true });
}

const landingInput = document.getElementById('landing-file-input');
if (landingInput) {
    landingInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        startChat('multimodal');
        const reader = new FileReader();
        reader.onload = (ev) => {
            setTimeout(() => {
                previewsEl.innerHTML += `<div class="preview"><img src="${ev.target.result}"><div class="rm" onclick="this.parentElement.remove();">✕</div></div>`;
                promptEl.value = "ช่วยวิเคราะห์ภาพนี้อย่างละเอียดครับ\\n1. สิ่งที่ตรวจพบ (Findings)\\n2. ความผิดปกติที่สงสัย (Impression)\\n3. คำแนะนำเพิ่มเติม (Recommendation)";
                promptEl.style.height = 'auto'; // Adjust height
                updateSendButtonState();
                handleSend();
            }, 300); // Give hash change a moment to render the chat view
        };
        reader.readAsDataURL(file);
        landingInput.value = ''; 
    });
}

// Router Logic
function handleHashChange() {
    const defaultHash = '#/';
    let currentHash = window.location.hash || defaultHash;
    
    if (currentHash === '#/') {
        _showLandingView();
    } else if (currentHash === '#/profile') {
        _renderProfileView();
    } else if (currentHash === '#/settings') {
        _renderSettingsView();
    } else if (currentHash.startsWith('#/chat/')) {
        const parts = currentHash.split('/');
        const idOrMode = parts[2];
        
        if (idOrMode === 'multimodal' || idOrMode === 'symptom') {
            startChat(idOrMode === 'multimodal' ? 'multimodal' : 'symptom_check');
        } else {
            _renderChat(idOrMode);
        }
    }
}
window.addEventListener('hashchange', handleHashChange);

// --- Theme Logic ---
document.addEventListener('DOMContentLoaded', () => {
    const htmlEl = document.documentElement;
    const themeToggleMenu = document.getElementById('theme-toggle-menu');

    function initTheme() {
        const savedTheme = localStorage.getItem('app-theme');
        if (savedTheme) {
            htmlEl.setAttribute('data-theme', savedTheme);
            updateThemeIcon(savedTheme === 'light');
        }
    }

    function updateThemeIcon(isLight) {
        if (!themeToggleMenu) return;
        const themeIcon = themeToggleMenu.querySelector('.material-icons');
        if(themeIcon) {
            themeIcon.textContent = isLight ? 'dark_mode' : 'light_mode';
        }
    }

    if (themeToggleMenu) {
        themeToggleMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            const currentTheme = htmlEl.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            
            htmlEl.setAttribute('data-theme', newTheme);
            localStorage.setItem('app-theme', newTheme);
            updateThemeIcon(newTheme === 'light');
        });
    }

    initVoice();
    initTheme(); 
    checkAuth(); 
    handleHashChange(); // Trigger router on load
    updateSendButtonState(); // Initial check
});