import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDDi5b_GBmRLSXQOXe-_ZA3bP6KuxHZvvQ",
    authDomain: "zing-talk-c6496.firebaseapp.com",
    projectId: "zing-talk-c6496",
    storageBucket: "zing-talk-c6496.firebasestorage.app",
    messagingSenderId: "214252384173",
    appId: "1:214252384173:web:c7af5b0d4c3c0f41f77b24",
    measurementId: "G-W87FM4ZNJ7"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
export const socket = io("https://zingtalk-4clj.onrender.com");

if (!document.getElementById("call-screen-container")) {
    const div = document.createElement("div");
    div.id = "call-screen-container";
    div.innerHTML = `
        <div id="full-call-screen" class="hidden">
            <video id="remote-video" autoplay playsinline></video>
            <video id="local-video" autoplay playsinline muted></video>
            <div class="call-controls"><button id="end-call-btn" class="danger-btn">End Call</button></div>
        </div>
        <div id="incoming-call-overlay" class="hidden">
            <h2 id="caller-name-display"></h2>
            <div class="call-actions">
                <button id="accept-call-btn" class="accept-btn">Accept</button>
                <button id="reject-call-btn" class="reject-btn">Reject</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

let currentUser = null;
let my5DigitUid = null;
let currentTargetUid = null;
let chatHistory = {};
let unreadCounts = {};
let myContacts = [];

let localStream = null;
let peerConnection = null;
let activeCallTarget = null;
let currentCallType = "video";
const rtcConfig = { iceServers: [{ urls: "stun:stun1.l.google.com:19302" }, { urls: "stun:stun2.l.google.com:19302" }] };

socket.on("connect", () => {
    if (currentUser) socket.emit("login_user", { email: currentUser.email, name: currentUser.displayName });
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        document.getElementById("login-screen")?.classList.add("hidden");
        document.getElementById("main-screen")?.classList.remove("hidden");
        socket.emit("login_user", { email: user.email, name: user.displayName });
    } else {
        document.getElementById("login-screen")?.classList.remove("hidden");
        document.getElementById("main-screen")?.classList.add("hidden");
        document.getElementById("chat-screen")?.classList.add("hidden");
    }
});

const loginBtn = document.getElementById("google-login-btn");
if (loginBtn) loginBtn.onclick = () => signInWithPopup(auth, provider).catch(err => alert(err.message));

socket.on("user_data", (data) => {
    my5DigitUid = data.uid;
    const nameEl = document.getElementById("my-name");
    const uidEl = document.getElementById("my-uid");
    const avatarEl = document.getElementById("my-avatar");
    if (nameEl) nameEl.innerText = currentUser.displayName;
    if (uidEl) uidEl.innerText = "UID: " + my5DigitUid;
    if (avatarEl) avatarEl.innerText = currentUser.displayName.charAt(0).toUpperCase();
    renderContacts(data.contacts);
});

const saveContactBtn = document.getElementById("save-contact-btn");
if (saveContactBtn) {
    saveContactBtn.onclick = () => {
        const searchUidInput = document.getElementById("search-uid-input");
        const saveNameInput = document.getElementById("save-name-input");
        if (searchUidInput?.value.trim() && saveNameInput?.value.trim()) {
            socket.emit("save_contact", { myUid: my5DigitUid, targetUid: searchUidInput.value.trim(), customName: saveNameInput.value.trim() });
        }
    };
}

socket.on("contact_saved", (contacts) => {
    if (document.getElementById("search-uid-input")) document.getElementById("search-uid-input").value = "";
    if (document.getElementById("save-name-input")) document.getElementById("save-name-input").value = "";
    renderContacts(contacts);
});

function renderContacts(contacts) {
    const contactsList = document.getElementById("contacts-list");
    if (!contactsList || !contacts) return;
    contactsList.innerHTML = "";
    myContacts = contacts;
    contacts.forEach(contact => {
        const unreadCount = unreadCounts[contact.uid] || 0;
        const badge = unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : "";
        const div = document.createElement("div");
        div.className = "contact-item";
        div.innerHTML = `<div class="avatar small">${contact.name.charAt(0).toUpperCase()}</div><div class="chat-contact-info"><span class="name-text">${contact.name}</span></div>${badge}`;
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
    
    const nameEl = document.getElementById("chat-contact-name") || document.getElementById("chat-user-name");
    if(nameEl) nameEl.innerText = contact.name;
    const avatarEl = document.getElementById("chat-avatar");
    if(avatarEl) avatarEl.innerText = contact.name.charAt(0).toUpperCase();
    
    const chatMessagesArea = document.getElementById("chat-messages");
    if (chatMessagesArea) {
        chatMessagesArea.innerHTML = "";
        if (chatHistory[contact.uid]) chatHistory[contact.uid].forEach(msg => appendMessage(msg, msg.type));
    }
}

const backBtn = document.getElementById("back-btn");
if(backBtn) {
    backBtn.onclick = () => {
        currentTargetUid = null;
        document.getElementById("chat-screen")?.classList.add("hidden");
        document.getElementById("main-screen")?.classList.remove("hidden");
    };
}

const sendBtn = document.getElementById("send-btn");
if(sendBtn) {
    sendBtn.onclick = () => {
        const messageInput = document.getElementById("message-input");
        const text = messageInput?.value.trim();
        if (text && currentTargetUid) {
            const msgData = { senderUid: my5DigitUid, receiverUid: currentTargetUid, text: text, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
            socket.emit("send_message", msgData);
            appendMessage(msgData, "msg-sent");
            if (!chatHistory[currentTargetUid]) chatHistory[currentTargetUid] = [];
            chatHistory[currentTargetUid].push({ ...msgData, type: "msg-sent" });
            messageInput.value = "";
        }
    };
}

socket.on("receive_message", (data) => {
    const sender = data.senderUid;
    if (!chatHistory[sender]) chatHistory[sender] = [];
    chatHistory[sender].push({ ...data, type: "msg-received" });

    if (currentTargetUid === sender) {
        appendMessage(data, "msg-received");
    } else {
        unreadCounts[sender] = (unreadCounts[sender] || 0) + 1;
        renderContacts(myContacts);
    }
});

function appendMessage(data, type) {
    const chatMessagesArea = document.getElementById("chat-messages");
    if (!chatMessagesArea) return;
    const div = document.createElement("div");
    div.className = `msg-bubble ${type}`;
    div.innerHTML = `${data.text} <br><span style="font-size: 10px; color: gray; float: right; margin-top: 5px;">${data.timestamp}</span>`;
    chatMessagesArea.appendChild(div);
    chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
}

// === CALLING LOGIC (STRICT) ===

document.addEventListener("click", (e) => {
    const text = e.target.innerText || "";
    if (text.includes("Video") || text.includes("Audio") || e.target.id === "video-call-btn" || e.target.id === "audio-call-btn") {
        if(!currentTargetUid) return;
        currentCallType = (text.includes("Video") || e.target.id === "video-call-btn") ? "video" : "audio";
        activeCallTarget = currentTargetUid;
        socket.emit("initiate_call", { callerUid: my5DigitUid, targetUid: currentTargetUid, callerName: currentUser.displayName, type: currentCallType });
    }
});

socket.on("incoming_call", (data) => {
    activeCallTarget = data.callerUid;
    currentCallType = data.type; 
    const callText = currentCallType === "video" ? "Incoming Video Call..." : "Incoming Audio Call...";
    document.getElementById("caller-name-display").innerHTML = `${data.callerName}<br><span style="font-size:16px; color:#ccc;">${callText}</span>`;
    document.getElementById("incoming-call-overlay").classList.remove("hidden");
});

document.getElementById("accept-call-btn").onclick = () => {
    document.getElementById("incoming-call-overlay").classList.add("hidden");
    socket.emit("call_response", { targetUid: activeCallTarget, status: "accepted" });
    startWebRTC(false);
};

document.getElementById("reject-call-btn").onclick = () => {
    document.getElementById("incoming-call-overlay").classList.add("hidden");
    socket.emit("call_response", { targetUid: activeCallTarget, status: "rejected" });
    activeCallTarget = null;
};

socket.on("call_response_received", (data) => {
    if(data.status === "accepted") {
        startWebRTC(true);
    } else {
        alert("Call Rejected");
        activeCallTarget = null;
    }
});

async function startWebRTC(isCaller) {
    document.getElementById("full-call-screen").classList.remove("hidden");
    
    const localVideo = document.getElementById("local-video");
    const remoteVideo = document.getElementById("remote-video");
    
    try {
        const constraints = { audio: true, video: currentCallType === "video" };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if(localVideo) {
            localVideo.srcObject = localStream;
            localVideo.style.display = currentCallType === "video" ? "block" : "none";
        }
    } catch (err) {
        alert("Camera ya Mic access required!");
        endCall();
        return;
    }
    
    peerConnection = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    
    peerConnection.ontrack = (event) => {
        if(remoteVideo) remoteVideo.srcObject = event.streams[0];
    };
    
    peerConnection.onicecandidate = (event) => {
        if(event.candidate) socket.emit("webrtc_ice_candidate", { targetUid: activeCallTarget, candidate: event.candidate });
    };
    
    if(isCaller) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit("webrtc_offer", { targetUid: activeCallTarget, offer: offer });
    }
}

socket.on("webrtc_offer_received", async (data) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("webrtc_answer", { targetUid: activeCallTarget, answer: answer });
});

socket.on("webrtc_answer_received", async (data) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
});

socket.on("webrtc_ice_candidate_received", async (data) => {
    if(peerConnection) await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
});

function endCall() {
    if(peerConnection) peerConnection.close();
    if(localStream) localStream.getTracks().forEach(track => track.stop());
    socket.emit("webrtc_end_call", { targetUid: activeCallTarget });
    activeCallTarget = null;
    document.getElementById("full-call-screen").classList.add("hidden");
}

document.getElementById("end-call-btn").onclick = endCall;

socket.on("webrtc_call_ended", () => {
    if(peerConnection) peerConnection.close();
    if(localStream) localStream.getTracks().forEach(track => track.stop());
    document.getElementById("full-call-screen").classList.add("hidden");
    activeCallTarget = null;
});
