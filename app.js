import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { 
    getAuth, 
    signInWithPopup, 
    GoogleAuthProvider, 
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    updateProfile,
    signOut
} from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";

// Client Firebase configuration for ZingTalk
const firebaseConfig = {
    apiKey: "AIzaSyAjvRGXKy9tHTMcyOFJXmrbYmMeVdczDjk",
    authDomain: "zing-talk-c6496.firebaseapp.com",
    projectId: "zing-talk-c6496",
    storageBucket: "zing-talk-c6496.firebasestorage.app",
    messagingSenderId: "214252384173",
    appId: "1:214252384173:web:c7af5b0d4c3c0f41f77b24"
};

let app, auth, provider;
try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    provider = new GoogleAuthProvider();
} catch (e) {
    console.warn("Firebase client init note:", e);
}

// Socket.io connection to local server
export const socket = (typeof io !== "undefined")
    ? io({ transports: ["websocket", "polling"] })
    : null;

export function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.style.opacity = "1";
    setTimeout(() => {
        toast.style.opacity = "0";
    }, 2800);
}

window.addEventListener("submit", (e) => e.preventDefault());

// Application State
export let currentUser = null;
export let my10DigitUid = null;
export let my5DigitUid = null; // Alias for backward compatibility
export let currentTargetUid = null;
let chatHistory = JSON.parse(localStorage.getItem("zingTalkHistory")) || {};
let unreadCounts = {};
let myContacts = [];
let localStream = null;
let peerConnection = null;
let activeCallTarget = null;
let currentCallType = "video";
let isMicMuted = false;
let callDurationTimer = null;
let callSecondsElapsed = 0;
let iceCandidatesQueue = [];
let isRegisterMode = false;
let adTimerInterval = null;

// Google's Public Free STUN Servers for WebRTC P2P Calling
const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" }
    ]
};

// Check for existing guest session
const savedGuest = localStorage.getItem("zingTalkGuestUser");
if (savedGuest) {
    try {
        const guestData = JSON.parse(savedGuest);
        if (guestData && guestData.email && guestData.displayName) {
            loginUserSession(guestData);
        }
    } catch (_) {}
}

if (socket) {
    socket.on("connect", () => {
        if (currentUser) {
            socket.emit("login_user", { email: currentUser.email, name: currentUser.displayName });
        }
    });
}

function loginUserSession(user) {
    currentUser = user;
    document.getElementById("login-screen")?.classList.add("hidden");
    document.getElementById("main-screen")?.classList.remove("hidden");
    if (socket && socket.connected) {
        socket.emit("login_user", { email: user.email, name: user.displayName || "User" });
    }
}

function logoutUserSession() {
    currentUser = null;
    my10DigitUid = null;
    my5DigitUid = null;
    currentTargetUid = null;
    localStorage.removeItem("zingTalkGuestUser");
    if (auth) {
        signOut(auth).catch(() => {});
    }
    document.getElementById("profile-modal")?.classList.add("hidden");
    document.getElementById("main-screen")?.classList.add("hidden");
    document.getElementById("chat-screen")?.classList.add("hidden");
    document.getElementById("login-screen")?.classList.remove("hidden");
    showToast("Logged out successfully");
}

if (auth) {
    onAuthStateChanged(auth, (user) => {
        if (user) {
            loginUserSession(user);
        } else if (!currentUser) {
            document.getElementById("login-screen")?.classList.remove("hidden");
            document.getElementById("main-screen")?.classList.add("hidden");
            document.getElementById("chat-screen")?.classList.add("hidden");
        }
    });
}

// ----------------- AdMob Interstitial Simulation -----------------
function triggerAdMobInterstitial() {
    const modal = document.getElementById("admob-interstitial-modal");
    const timerText = document.getElementById("admob-timer-text");
    const closeBtn = document.getElementById("admob-close-btn");
    if (!modal || !timerText || !closeBtn) return;

    modal.classList.remove("hidden");
    let countdown = 5;
    timerText.style.display = "inline";
    timerText.textContent = `Skip in ${countdown}s`;
    closeBtn.style.display = "none";

    clearInterval(adTimerInterval);
    adTimerInterval = setInterval(() => {
        countdown--;
        if (countdown > 0) {
            timerText.textContent = `Skip in ${countdown}s`;
        } else {
            clearInterval(adTimerInterval);
            timerText.style.display = "none";
            closeBtn.style.display = "inline-block";
        }
    }, 1000);
}

// ----------------- Socket Events -----------------
if (socket) {
    socket.on("user_data", (data) => {
        my10DigitUid = data.uid;
        my5DigitUid = data.uid;
        const displayName = (currentUser && currentUser.displayName) ? currentUser.displayName : "User";
        
        if (document.getElementById("my-name")) document.getElementById("my-name").innerText = displayName;
        if (document.getElementById("my-uid-label")) document.getElementById("my-uid-label").innerText = "UID: " + my10DigitUid;
        if (document.getElementById("my-avatar")) document.getElementById("my-avatar").innerText = displayName.charAt(0).toUpperCase();
        
        renderContacts(data.contacts);
    });

    socket.on("contact_saved", (contacts) => {
        if (document.getElementById("search-uid-input")) document.getElementById("search-uid-input").value = "";
        if (document.getElementById("save-name-input")) document.getElementById("save-name-input").value = "";
        showToast("Contact saved successfully!");
        renderContacts(contacts);
    });

    socket.on("contact_error", (msg) => {
        showToast(msg);
    });

    socket.on("receive_message", (data) => {
        const sender = data.senderUid;
        if (!chatHistory[sender]) chatHistory[sender] = [];
        chatHistory[sender].push({ ...data, type: "msg-received" });
        localStorage.setItem("zingTalkHistory", JSON.stringify(chatHistory));

        if (currentTargetUid === sender) {
            appendMessage(data, "msg-received");
        } else {
            unreadCounts[sender] = (unreadCounts[sender] || 0) + 1;
            renderContacts(myContacts);
        }
    });

    socket.on("incoming_call", (data) => {
        activeCallTarget = data.callerUid;
        currentCallType = data.type || "video";

        let callerNameToShow = "UID: " + data.callerUid;
        const knownContact = myContacts.find(c => c.uid === data.callerUid);
        if (knownContact) {
            callerNameToShow = knownContact.name;
        }

        const callerDisplay = document.getElementById("caller-name-display");
        if (callerDisplay) {
            callerDisplay.innerText = callerNameToShow;
        }
        const callTypeEl = document.getElementById("incoming-call-type");
        if (callTypeEl) {
            callTypeEl.innerText = `Incoming ${currentCallType === 'video' ? 'Video' : 'HD Audio'} Call...`;
        }
        document.getElementById("incoming-call-overlay")?.classList.remove("hidden");
    });

    socket.on("call_cancelled", () => {
        document.getElementById("incoming-call-overlay")?.classList.add("hidden");
        activeCallTarget = null;
        showToast("Call cancelled by caller");
    });

    socket.on("call_response_received", async (data) => {
        document.getElementById("outgoing-call-overlay")?.classList.add("hidden");
        if (data.status === "accepted") {
            await startWebRTC(true);
        } else {
            showToast("The other person declined the call.");
            activeCallTarget = null;
        }
    });

    socket.on("webrtc_offer_received", async (data) => {
        if (!peerConnection) return;
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit("webrtc_answer", { targetUid: activeCallTarget, answer });

            while (iceCandidatesQueue.length > 0) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(iceCandidatesQueue.shift()));
            }
        } catch (err) {
            console.error("Error handling WebRTC offer:", err);
        }
    });

    socket.on("webrtc_answer_received", async (data) => {
        if (!peerConnection) return;
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));

            while (iceCandidatesQueue.length > 0) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(iceCandidatesQueue.shift()));
            }
        } catch (err) {
            console.error("Error handling WebRTC answer:", err);
        }
    });

    socket.on("webrtc_ice_candidate_received", async (data) => {
        if (peerConnection && peerConnection.remoteDescription) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
                console.error("Error adding ice candidate:", err);
            }
        } else {
            iceCandidatesQueue.push(data.candidate);
        }
    });

    socket.on("webrtc_call_ended", () => {
        endCallCleanup();
        showToast("Call ended");
        triggerAdMobInterstitial();
    });
}

// ----------------- UI Rendering -----------------
function renderContacts(contacts) {
    const contactsList = document.getElementById("contacts-list");
    if (!contactsList || !contacts) return;
    contactsList.innerHTML = "";
    myContacts = contacts;

    if (contacts.length === 0) {
        contactsList.innerHTML = `
            <div style="padding: 44px 24px; text-align: center; color: #8696a0;">
                <div style="font-size: 42px; margin-bottom: 12px;">💬</div>
                <p style="font-size: 16px; font-weight: 700; color: #111b21; margin-bottom: 6px;">No conversations yet</p>
                <p style="font-size: 13px; line-height: 1.4;">Enter a friend's 10-digit UID above to start chatting and calling!</p>
            </div>
        `;
        return;
    }

    contacts.forEach(contact => {
        const unreadCount = unreadCounts[contact.uid] || 0;
        const badge = unreadCount > 0 ? `<span class="unread-pill">${unreadCount}</span>` : "";
        const div = document.createElement("div");
        div.className = "contact-row";
        div.innerHTML = `
            <div class="avatar small">${(contact.name || "U").charAt(0).toUpperCase()}</div>
            <div class="contact-info">
                <span class="contact-name">${contact.name}</span>
                <span class="contact-uid-label">UID: ${contact.uid}</span>
            </div>
            ${badge}
        `;
        div.onclick = () => openChat(contact);
        contactsList.appendChild(div);
    });
}

function openChat(contact) {
    currentTargetUid = contact.uid;
    unreadCounts[contact.uid] = 0;
    renderContacts(myContacts);
    document.getElementById("main-screen")?.classList.add("hidden");
    document.getElementById("chat-screen")?.classList.remove("hidden");

    if (document.getElementById("chat-contact-name")) document.getElementById("chat-contact-name").innerText = contact.name;
    if (document.getElementById("chat-contact-uid")) document.getElementById("chat-contact-uid").innerText = "UID: " + contact.uid;
    if (document.getElementById("chat-avatar")) document.getElementById("chat-avatar").innerText = (contact.name || "U").charAt(0).toUpperCase();

    const chatMessagesArea = document.getElementById("messages-area");
    if (chatMessagesArea) {
        chatMessagesArea.innerHTML = `<div class="date-divider">TODAY</div>`;
        if (chatHistory[contact.uid]) {
            chatHistory[contact.uid].forEach(msg => appendMessage(msg, msg.type));
        }
    }
}

function sendMessageLogic() {
    const messageInput = document.getElementById("message-input");
    const text = messageInput?.value.trim();
    if (text && currentTargetUid && socket) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const msgData = {
            senderUid: my10DigitUid,
            receiverUid: currentTargetUid,
            text: text,
            timestamp: timeStr
        };
        socket.emit("send_message", msgData);
        appendMessage(msgData, "msg-sent");

        if (!chatHistory[currentTargetUid]) chatHistory[currentTargetUid] = [];
        chatHistory[currentTargetUid].push({ ...msgData, type: "msg-sent" });
        try {
            localStorage.setItem("zingTalkHistory", JSON.stringify(chatHistory));
        } catch (_) {}

        messageInput.value = "";
    }
}

function appendMessage(data, type) {
    const chatMessagesArea = document.getElementById("messages-area");
    if (!chatMessagesArea) return;
    const div = document.createElement("div");
    div.className = `msg-bubble ${type}`;
    
    let mediaHtml = "";
    if (data.media) {
        if (data.media.type === "image") {
            mediaHtml = `<img src="${data.media.dataUrl}" class="chat-media-img" alt="${escapeHtml(data.media.name || 'Photo')}" title="Click to view full size" />`;
        } else if (data.media.type === "audio") {
            mediaHtml = `
                <div class="chat-media-audio">
                    <audio controls preload="metadata" src="${data.media.dataUrl}"></audio>
                </div>
            `;
        } else if (data.media.type === "video") {
            mediaHtml = `
                <video controls preload="metadata" playsinline src="${data.media.dataUrl}" class="chat-media-video"></video>
            `;
        }
    }

    const captionHtml = data.text ? `<div class="${data.media ? 'media-caption' : ''}">${escapeHtml(data.text)}</div>` : '';
    const checkmark = type === 'msg-sent' ? `<span style="color:#53bdeb; margin-left: 2px;">✓✓</span>` : '';

    div.innerHTML = `
        ${mediaHtml}
        ${captionHtml}
        <span class="msg-meta">
            ${data.timestamp || ''}
            ${checkmark}
        </span>
    `;

    // Click on shared image to open full-screen viewer
    if (data.media && data.media.type === "image") {
        const imgEl = div.querySelector(".chat-media-img");
        if (imgEl) {
            imgEl.addEventListener("click", () => openMediaViewer(data.media));
        }
    }

    chatMessagesArea.appendChild(div);
    chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
}

function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ----------------- Zero-Server Media & Voice Note Engine -----------------
function openMediaViewer(mediaData) {
    const modal = document.getElementById("media-viewer-modal");
    const content = document.getElementById("media-viewer-content");
    const downloadLink = document.getElementById("media-download-link");
    if (!modal || !content) return;

    content.innerHTML = "";
    if (mediaData.type === "image") {
        const img = document.createElement("img");
        img.src = mediaData.dataUrl;
        img.className = "media-viewer-preview";
        img.alt = mediaData.name || "Preview";
        content.appendChild(img);
    } else if (mediaData.type === "video") {
        const video = document.createElement("video");
        video.src = mediaData.dataUrl;
        video.controls = true;
        video.autoplay = true;
        video.className = "media-viewer-preview";
        content.appendChild(video);
    }

    if (downloadLink) {
        downloadLink.href = mediaData.dataUrl;
        downloadLink.download = mediaData.name || `zingtalk_${Date.now()}`;
    }

    modal.classList.remove("hidden");
}

// Media file input handler (Zero server storage - direct peer transmission)
const mediaFileInput = document.getElementById("media-file-input");
if (mediaFileInput) {
    mediaFileInput.addEventListener("change", () => {
        const file = mediaFileInput.files && mediaFileInput.files[0];
        if (!file) return;
        if (!currentTargetUid) {
            showToast("Please open a conversation to share media");
            return;
        }

        if (file.size > 25 * 1024 * 1024) {
            showToast("File size too large (max 25MB). Direct peer transmission limit.");
            return;
        }

        showToast(`Sending ${file.name}... (Zero server storage)`);
        const reader = new FileReader();
        reader.onload = () => {
            let mediaType = "file";
            if (file.type.startsWith("image/")) mediaType = "image";
            else if (file.type.startsWith("audio/")) mediaType = "audio";
            else if (file.type.startsWith("video/")) mediaType = "video";

            const now = new Date();
            const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const messageInput = document.getElementById("message-input");
            const caption = messageInput ? messageInput.value.trim() : "";

            const msgData = {
                senderUid: my10DigitUid,
                receiverUid: currentTargetUid,
                text: caption,
                media: {
                    type: mediaType,
                    dataUrl: reader.result,
                    name: file.name,
                    size: file.size
                },
                timestamp: timeStr
            };

            if (socket) {
                socket.emit("send_message", msgData);
            }
            appendMessage(msgData, "msg-sent");
            if (!chatHistory[currentTargetUid]) chatHistory[currentTargetUid] = [];
            chatHistory[currentTargetUid].push({ ...msgData, type: "msg-sent" });
            try {
                localStorage.setItem("zingTalkHistory", JSON.stringify(chatHistory));
            } catch (err) {
                console.warn("Storage note:", err);
            }

            if (messageInput) messageInput.value = "";
            mediaFileInput.value = "";
            document.getElementById("attachment-popover")?.classList.add("hidden");
            showToast("Media sent directly (Zero server storage)");
        };
        reader.readAsDataURL(file);
    });
}

// Direct Live Voice Note Recorder
let mediaRecorder = null;
let audioChunks = [];
let isRecordingVoice = false;

async function toggleVoiceRecording() {
    if (isRecordingVoice) {
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
        }
        isRecordingVoice = false;
        showToast("Processing voice note...");
        return;
    }

    if (!currentTargetUid) {
        showToast("Please open a chat to record a voice note");
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
            const reader = new FileReader();
            reader.onloadend = () => {
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const msgData = {
                    senderUid: my10DigitUid,
                    receiverUid: currentTargetUid,
                    text: "🎙️ Voice Note",
                    media: {
                        type: "audio",
                        dataUrl: reader.result,
                        name: "voice_note_" + Date.now() + ".webm",
                        size: audioBlob.size
                    },
                    timestamp: timeStr
                };

                if (socket) {
                    socket.emit("send_message", msgData);
                }
                appendMessage(msgData, "msg-sent");
                if (!chatHistory[currentTargetUid]) chatHistory[currentTargetUid] = [];
                chatHistory[currentTargetUid].push({ ...msgData, type: "msg-sent" });
                try {
                    localStorage.setItem("zingTalkHistory", JSON.stringify(chatHistory));
                } catch (_) {}

                showToast("Voice note sent (Zero server storage)");
            };
            reader.readAsDataURL(audioBlob);
            stream.getTracks().forEach(t => t.stop());
        };

        mediaRecorder.start();
        isRecordingVoice = true;
        showToast("🔴 Recording voice note... Click Voice Note again to send");
        document.getElementById("attachment-popover")?.classList.add("hidden");
    } catch (err) {
        console.warn("Microphone access error:", err);
        showToast("Microphone access needed: " + err.message);
    }
}

// ----------------- WebRTC Calling Engine (Audio & Video) -----------------
async function startWebRTC(isCaller) {
    document.getElementById("full-call-screen")?.classList.remove("hidden");
    const localVideo = document.getElementById("local-video");
    const remoteVideo = document.getElementById("remote-video");
    const audioVisualizer = document.getElementById("audio-call-visualizer");
    const audioPeerName = document.getElementById("audio-call-peer-name");

    let peerNameToShow = "UID: " + activeCallTarget;
    const knownContact = myContacts.find(c => c.uid === activeCallTarget);
    if (knownContact) peerNameToShow = knownContact.name;

    if (currentCallType === "audio") {
        if (localVideo) localVideo.classList.add("hidden");
        if (remoteVideo) remoteVideo.style.opacity = "0"; // Invisible video but plays audio stream
        if (audioVisualizer) {
            audioVisualizer.classList.remove("hidden");
            if (audioPeerName) audioPeerName.innerText = peerNameToShow;
        }
    } else {
        if (localVideo) localVideo.classList.remove("hidden");
        if (remoteVideo) remoteVideo.style.opacity = "1";
        if (audioVisualizer) audioVisualizer.classList.add("hidden");
    }

    const constraints = { audio: true, video: currentCallType === "video" };
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
        console.warn("Could not acquire media stream:", err);
        showToast("Camera/Mic not accessible: " + err.message);
        endCall();
        return;
    }

    if (localVideo && currentCallType === "video") {
        localVideo.srcObject = localStream;
    }

    peerConnection = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
        const remote = document.getElementById("remote-video");
        if (remote) {
            remote.srcObject = event.streams[0];
            remote.play().catch(e => console.log(e));
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && socket) {
            socket.emit("webrtc_ice_candidate", { targetUid: activeCallTarget, candidate: event.candidate });
        }
    };

    // Start Call Duration Timer
    callSecondsElapsed = 0;
    clearInterval(callDurationTimer);
    const timerEl = document.getElementById("call-timer");
    callDurationTimer = setInterval(() => {
        callSecondsElapsed++;
        const mins = String(Math.floor(callSecondsElapsed / 60)).padStart(2, '0');
        const secs = String(callSecondsElapsed % 60).padStart(2, '0');
        const modeLabel = currentCallType === "video" ? "HD Video" : "HD Audio";
        if (timerEl) timerEl.innerText = `${mins}:${secs} • ${modeLabel}`;
    }, 1000);

    if (isCaller) {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit("webrtc_offer", { targetUid: activeCallTarget, offer });
        } catch (err) {
            console.error("Failed to create offer:", err);
        }
    }
}

function endCallCleanup() {
    clearInterval(callDurationTimer);
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    activeCallTarget = null;
    iceCandidatesQueue = [];
    document.getElementById("full-call-screen")?.classList.add("hidden");
    document.getElementById("audio-call-visualizer")?.classList.add("hidden");
}

function endCall() {
    if (socket && activeCallTarget) {
        socket.emit("webrtc_end_call", { targetUid: activeCallTarget });
    }
    endCallCleanup();
    triggerAdMobInterstitial();
}

function showLoginError(msg) {
    const box = document.getElementById("login-message");
    if (!box) return;
    box.style.display = "block";
    box.textContent = msg;
}

function clearLoginError() {
    const box = document.getElementById("login-message");
    if (!box) return;
    box.style.display = "none";
    box.textContent = "";
}

// ----------------- Global Event Listeners -----------------
document.addEventListener("click", async (e) => {
    if (e.target.tagName === "BUTTON") e.preventDefault();

    // Close Attachment Popover when clicking outside
    if (!e.target.closest("#attach-btn") && !e.target.closest("#attachment-popover")) {
        document.getElementById("attachment-popover")?.classList.add("hidden");
    }

    // 1. Login Tab Switchers
    if (e.target.id === "tab-btn-google") {
        clearLoginError();
        document.querySelectorAll(".login-tab").forEach(t => t.classList.remove("active"));
        e.target.classList.add("active");
        document.querySelectorAll(".tab-pane").forEach(p => p.classList.add("hidden"));
        document.getElementById("pane-google")?.classList.remove("hidden");
    }
    if (e.target.id === "tab-btn-email") {
        clearLoginError();
        document.querySelectorAll(".login-tab").forEach(t => t.classList.remove("active"));
        e.target.classList.add("active");
        document.querySelectorAll(".tab-pane").forEach(p => p.classList.add("hidden"));
        document.getElementById("pane-email")?.classList.remove("hidden");
    }
    if (e.target.id === "tab-btn-guest") {
        clearLoginError();
        document.querySelectorAll(".login-tab").forEach(t => t.classList.remove("active"));
        e.target.classList.add("active");
        document.querySelectorAll(".tab-pane").forEach(p => p.classList.add("hidden"));
        document.getElementById("pane-guest")?.classList.remove("hidden");
    }

    // Toggle Email Sign In / Register
    if (e.target.id === "auth-toggle-link") {
        clearLoginError();
        isRegisterMode = !isRegisterMode;
        const nameGroup = document.getElementById("email-name-group");
        const submitBtn = document.getElementById("email-submit-btn");
        const promptText = document.getElementById("auth-toggle-prompt");
        const linkText = document.getElementById("auth-toggle-link");

        if (isRegisterMode) {
            nameGroup.style.display = "block";
            submitBtn.textContent = "Create Account";
            promptText.textContent = "Already have an account?";
            linkText.textContent = "Sign In";
        } else {
            nameGroup.style.display = "none";
            submitBtn.textContent = "Sign In with Email";
            promptText.textContent = "Don't have an account?";
            linkText.textContent = "Register";
        }
    }

    // Google Login button
    if (e.target.id === "google-login-btn" || e.target.closest("#google-login-btn")) {
        clearLoginError();
        if (auth && provider) {
            signInWithPopup(auth, provider).catch(err => {
                showLoginError("Google Sign-in: " + err.message);
                showToast("Google Sign-in note: " + err.message);
            });
        } else {
            showLoginError("Firebase Auth is not initialized. Please try Guest login.");
        }
    }

    // Email & Password Auth Submit
    if (e.target.id === "email-submit-btn" || e.target.closest("#email-submit-btn")) {
        clearLoginError();
        const email = document.getElementById("email-input")?.value.trim();
        const password = document.getElementById("password-input")?.value;
        const displayName = document.getElementById("email-name-input")?.value.trim() || email.split("@")[0];

        if (!email || !password) {
            showLoginError("Please enter both email and password.");
            return;
        }

        if (password.length < 6) {
            showLoginError("Password must be at least 6 characters.");
            return;
        }

        if (!auth) {
            showLoginError("Firebase Auth unavailable. Please use Guest login.");
            return;
        }

        if (isRegisterMode) {
            createUserWithEmailAndPassword(auth, email, password)
                .then(async (userCredential) => {
                    if (displayName && userCredential.user) {
                        await updateProfile(userCredential.user, { displayName });
                    }
                    showToast("Account created successfully!");
                    loginUserSession({ ...userCredential.user, displayName });
                })
                .catch(err => {
                    showLoginError(err.message);
                });
        } else {
            signInWithEmailAndPassword(auth, email, password)
                .then((userCredential) => {
                    showToast("Welcome back!");
                    loginUserSession(userCredential.user);
                })
                .catch(err => {
                    showLoginError(err.message);
                });
        }
    }

    // Guest Login button
    if (e.target.id === "guest-login-btn" || e.target.closest("#guest-login-btn")) {
        const nameInput = document.getElementById("guest-name-input");
        const enteredName = nameInput?.value.trim() || "Guest " + Math.floor(100 + Math.random() * 900);
        const guestUser = {
            displayName: enteredName,
            email: `${enteredName.toLowerCase().replace(/[^a-z0-9]/g, '')}_${Math.floor(1000 + Math.random() * 9000)}@guest.local`
        };
        localStorage.setItem("zingTalkGuestUser", JSON.stringify(guestUser));
        loginUserSession(guestUser);
    }

    // Open Profile Modal
    if (e.target.id === "my-profile" || e.target.closest("#my-profile") || e.target.id === "header-profile-btn" || e.target.closest("#header-profile-btn")) {
        const displayName = (currentUser && currentUser.displayName) ? currentUser.displayName : "User";
        const email = (currentUser && currentUser.email) ? currentUser.email : "No email linked";
        
        document.getElementById("modal-avatar").innerText = displayName.charAt(0).toUpperCase();
        document.getElementById("modal-name").innerText = displayName;
        document.getElementById("modal-email").innerText = email;
        document.getElementById("modal-uid").innerText = my10DigitUid || "Generating...";
        document.getElementById("profile-modal")?.classList.remove("hidden");
    }

    // Close Profile Modal
    if (e.target.id === "close-profile-modal-btn") {
        document.getElementById("profile-modal")?.classList.add("hidden");
    }

    // Copy UID button inside Profile Modal
    if (e.target.id === "copy-uid-btn") {
        if (my10DigitUid) {
            navigator.clipboard.writeText(my10DigitUid).then(() => {
                showToast("10-Digit UID copied: " + my10DigitUid);
            }).catch(() => {
                showToast("UID: " + my10DigitUid);
            });
        }
    }

    // Header Quick Copy UID
    if (e.target.id === "my-uid" || e.target.closest("#my-uid")) {
        if (my10DigitUid) {
            navigator.clipboard.writeText(my10DigitUid).then(() => {
                showToast("UID copied: " + my10DigitUid);
            }).catch(() => {
                showToast("UID: " + my10DigitUid);
            });
        }
    }

    // Logout from Header or Modal
    if (e.target.id === "header-logout-btn" || e.target.closest("#header-logout-btn") || e.target.id === "modal-logout-btn") {
        logoutUserSession();
    }

    // Save Contact button (10-Digit UID)
    if (e.target.id === "save-contact-btn" || e.target.closest("#save-contact-btn")) {
        const targetUid = document.getElementById("search-uid-input")?.value.trim();
        const customName = document.getElementById("save-name-input")?.value.trim();
        if (targetUid === my10DigitUid) return showToast("You cannot save your own UID!");
        if (!targetUid || !customName) return showToast("Please enter 10-digit UID and a name");
        if (targetUid.length < 5) return showToast("Please enter a valid UID");
        if (socket) {
            socket.emit("save_contact", { myUid: my10DigitUid, targetUid, customName });
        }
    }

    // Back button in chat
    if (e.target.id === "back-btn" || e.target.closest("#back-btn")) {
        currentTargetUid = null;
        document.getElementById("chat-screen")?.classList.add("hidden");
        document.getElementById("main-screen")?.classList.remove("hidden");
    }

    // Send button in chat
    if (e.target.id === "send-btn" || e.target.closest("#send-btn")) {
        sendMessageLogic();
    }

    // Attachment Button: Toggle Popover
    if (e.target.id === "attach-btn" || e.target.closest("#attach-btn")) {
        document.getElementById("attachment-popover")?.classList.toggle("hidden");
    }

    // Attachment Option: Photo
    if (e.target.id === "attach-photo-btn" || e.target.closest("#attach-photo-btn")) {
        const input = document.getElementById("media-file-input");
        if (input) {
            input.accept = "image/*";
            input.click();
        }
        document.getElementById("attachment-popover")?.classList.add("hidden");
    }

    // Attachment Option: Audio
    if (e.target.id === "attach-audio-btn" || e.target.closest("#attach-audio-btn")) {
        const input = document.getElementById("media-file-input");
        if (input) {
            input.accept = "audio/*";
            input.click();
        }
        document.getElementById("attachment-popover")?.classList.add("hidden");
    }

    // Attachment Option: Voice Note Record
    if (e.target.id === "attach-record-btn" || e.target.closest("#attach-record-btn")) {
        toggleVoiceRecording();
    }

    // Attachment Option: Video
    if (e.target.id === "attach-video-btn" || e.target.closest("#attach-video-btn")) {
        const input = document.getElementById("media-file-input");
        if (input) {
            input.accept = "video/*";
            input.click();
        }
        document.getElementById("attachment-popover")?.classList.add("hidden");
    }

    // Close Media Viewer Modal
    if (e.target.id === "close-media-viewer-btn" || e.target.closest("#close-media-viewer-btn")) {
        document.getElementById("media-viewer-modal")?.classList.add("hidden");
    }

    // Privacy Policy & Terms Modal Triggers
    if (e.target.id === "open-policy-btn-login" || e.target.id === "header-policy-btn" || e.target.closest("#header-policy-btn") || e.target.id === "open-policy-btn-modal" || e.target.closest("#open-policy-btn-modal")) {
        document.getElementById("policy-modal")?.classList.remove("hidden");
    }

    // Close Privacy Policy Modal
    if (e.target.id === "close-policy-btn" || e.target.closest("#close-policy-btn")) {
        document.getElementById("policy-modal")?.classList.add("hidden");
    }

    // Privacy Policy Tabs
    if (e.target.id === "tab-privacy-btn") {
        document.getElementById("tab-privacy-btn")?.classList.add("active");
        document.getElementById("tab-terms-btn")?.classList.remove("active");
        document.getElementById("policy-privacy-text")?.classList.remove("hidden");
        document.getElementById("policy-terms-text")?.classList.add("hidden");
    }
    if (e.target.id === "tab-terms-btn") {
        document.getElementById("tab-terms-btn")?.classList.add("active");
        document.getElementById("tab-privacy-btn")?.classList.remove("active");
        document.getElementById("policy-terms-text")?.classList.remove("hidden");
        document.getElementById("policy-privacy-text")?.classList.add("hidden");
    }

    // Call buttons (Audio / Video)
    const text = e.target.innerText || "";
    if (text.includes("Video") || text.includes("Audio") || e.target.id === "video-call-btn" || e.target.id === "audio-call-btn" || e.target.closest("#video-call-btn") || e.target.closest("#audio-call-btn")) {
        if (!currentTargetUid) return showToast("Please open a chat to make a call!");
        const isVideo = text.includes("Video") || e.target.id === "video-call-btn" || !!e.target.closest("#video-call-btn");
        currentCallType = isVideo ? "video" : "audio";
        activeCallTarget = currentTargetUid;

        let targetNameToShow = "UID: " + currentTargetUid;
        const contact = myContacts.find(c => c.uid === currentTargetUid);
        if (contact) targetNameToShow = contact.name;

        const outgoingName = document.getElementById("outgoing-call-name");
        if (outgoingName) {
            outgoingName.innerText = targetNameToShow;
        }
        const outgoingType = document.getElementById("outgoing-call-type");
        if (outgoingType) {
            outgoingType.innerText = `Calling (${currentCallType === 'video' ? 'Video' : 'HD Audio'})...`;
        }
        document.getElementById("outgoing-call-overlay")?.classList.remove("hidden");

        if (socket) {
            socket.emit("initiate_call", {
                callerUid: my10DigitUid,
                targetUid: currentTargetUid,
                callerName: currentUser ? currentUser.displayName : "User",
                type: currentCallType
            });
        }
    }

    // Cancel Outgoing Call button
    if (e.target.id === "cancel-outgoing-btn" || e.target.closest("#cancel-outgoing-btn")) {
        document.getElementById("outgoing-call-overlay")?.classList.add("hidden");
        if (socket && activeCallTarget) {
            socket.emit("cancel_call", { targetUid: activeCallTarget });
        }
        activeCallTarget = null;
    }

    // Accept Incoming Call button
    if (e.target.id === "accept-call-btn" || e.target.closest("#accept-call-btn")) {
        document.getElementById("incoming-call-overlay")?.classList.add("hidden");
        try {
            await startWebRTC(false);
            if (socket) {
                socket.emit("call_response", { targetUid: activeCallTarget, status: "accepted" });
            }
        } catch (err) {
            if (socket) {
                socket.emit("call_response", { targetUid: activeCallTarget, status: "rejected" });
            }
            activeCallTarget = null;
        }
    }

    // Reject Incoming Call button
    if (e.target.id === "reject-call-btn" || e.target.closest("#reject-call-btn")) {
        document.getElementById("incoming-call-overlay")?.classList.add("hidden");
        if (socket && activeCallTarget) {
            socket.emit("call_response", { targetUid: activeCallTarget, status: "rejected" });
        }
        activeCallTarget = null;
    }

    // Mute / Unmute Mic in Call
    if (e.target.id === "mute-mic-btn" || e.target.closest("#mute-mic-btn")) {
        if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                isMicMuted = !isMicMuted;
                audioTrack.enabled = !isMicMuted;
                showToast(isMicMuted ? "Microphone muted" : "Microphone unmuted");
                const muteBtn = document.getElementById("mute-mic-btn");
                if (muteBtn) {
                    muteBtn.style.background = isMicMuted ? "#ea4335" : "rgba(255,255,255,0.2)";
                }
            }
        }
    }

    // Toggle Camera in Call
    if (e.target.id === "toggle-video-btn" || e.target.closest("#toggle-video-btn")) {
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                showToast(videoTrack.enabled ? "Camera enabled" : "Camera turned off");
                const toggleBtn = document.getElementById("toggle-video-btn");
                if (toggleBtn) {
                    toggleBtn.style.background = videoTrack.enabled ? "rgba(255,255,255,0.2)" : "#ea4335";
                }
            } else {
                showToast("No active camera track in audio mode");
            }
        }
    }

    // End Active Call button
    if (e.target.id === "end-call-btn" || e.target.closest("#end-call-btn")) {
        endCall();
    }

    // Close AdMob Interstitial Modal
    if (e.target.id === "admob-close-btn") {
        clearInterval(adTimerInterval);
        document.getElementById("admob-interstitial-modal")?.classList.add("hidden");
    }
});

document.addEventListener("keypress", (e) => {
    if (e.key === "Enter" && document.activeElement === document.getElementById("message-input")) {
        e.preventDefault();
        sendMessageLogic();
    } else if (e.key === "Enter" && document.activeElement === document.getElementById("guest-name-input")) {
        e.preventDefault();
        document.getElementById("guest-login-btn")?.click();
    } else if (e.key === "Enter" && (document.activeElement === document.getElementById("email-input") || document.activeElement === document.getElementById("password-input"))) {
        e.preventDefault();
        document.getElementById("email-submit-btn")?.click();
    }
});
