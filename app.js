import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDDi5b_GBmRLSXQOXe-_ZA3bP6KuxHZvvQ",
    authDomain: "zing-talk-c6496.firebaseapp.com",
    projectId: "zing-talk-c6496",
    storageBucket: "zing-talk-c6496.firebasestorage.app",
    messagingSenderId: "214252384173",
    appId: "1:214252384173:web:c7af5b0d4c3c0f41f77b24"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
export const socket = io("https://zingtalk-4clj.onrender.com", { transports: ["websocket", "polling"] });

window.addEventListener("submit", (e) => e.preventDefault());

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
        <div id="outgoing-call-overlay" class="hidden">
            <h2 id="outgoing-call-name"></h2>
            <div class="call-actions">
                <button id="cancel-outgoing-btn" class="reject-btn">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

let currentUser = null;
let my5DigitUid = null;
let currentTargetUid = null;
let chatHistory = JSON.parse(localStorage.getItem("zingTalkHistory")) || {};
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

socket.on("user_data", (data) => {
    my5DigitUid = data.uid;
    if(document.getElementById("my-name")) document.getElementById("my-name").innerText = currentUser.displayName;
    if(document.getElementById("my-uid")) document.getElementById("my-uid").innerText = "UID: " + my5DigitUid;
    if(document.getElementById("my-avatar")) document.getElementById("my-avatar").innerText = currentUser.displayName.charAt(0).toUpperCase();
    renderContacts(data.contacts);
});

socket.on("contact_saved", (contacts) => {
    if(document.getElementById("search-uid-input")) document.getElementById("search-uid-input").value = "";
    if(document.getElementById("save-name-input")) document.getElementById("save-name-input").value = "";
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
    
    if(document.getElementById("chat-contact-name")) document.getElementById("chat-contact-name").innerText = contact.name;
    if(document.getElementById("chat-avatar")) document.getElementById("chat-avatar").innerText = contact.name.charAt(0).toUpperCase();
    
    const chatMessagesArea = document.getElementById("chat-messages") || document.querySelector(".messages-container");
    if (chatMessagesArea) {
        chatMessagesArea.innerHTML = "";
        if (chatHistory[contact.uid]) chatHistory[contact.uid].forEach(msg => appendMessage(msg, msg.type));
    }
}

function sendMessageLogic() {
    const messageInput = document.getElementById("message-input");
    const text = messageInput?.value.trim();
    if (text && currentTargetUid) {
        const msgData = { senderUid: my5DigitUid, receiverUid: currentTargetUid, text: text, timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
        socket.emit("send_message", msgData);
        appendMessage(msgData, "msg-sent");
        
        if (!chatHistory[currentTargetUid]) chatHistory[currentTargetUid] = [];
        chatHistory[currentTargetUid].push({ ...msgData, type: "msg-sent" });
        localStorage.setItem("zingTalkHistory", JSON.stringify(chatHistory)); 
        
        messageInput.value = "";
    }
}

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

function appendMessage(data, type) {
    const chatMessagesArea = document.getElementById("chat-messages") || document.querySelector(".messages-container");
    if (!chatMessagesArea) return;
    const div = document.createElement("div");
    div.className = `msg-bubble ${type}`;
    div.innerHTML = `${data.text} <br><span style="font-size: 10px; color: gray; float: right; margin-top: 5px;">${data.timestamp}</span>`;
    chatMessagesArea.appendChild(div);
    chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
}

document.addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON") e.preventDefault(); 

    if (e.target.id === "google-login-btn" || e.target.closest("#google-login-btn")) {
        signInWithPopup(auth, provider).catch(err => alert(err.message));
    }
    
    if (e.target.id === "save-contact-btn" || e.target.closest("#save-contact-btn")) {
        const targetUid = document.getElementById("search-uid-input")?.value.trim();
        const customName = document.getElementById("save-name-input")?.value.trim();
        if (targetUid === my5DigitUid) return alert("Aap apna khud ka UID save nahi kar sakte!");
        if (targetUid && customName) socket.emit("save_contact", { myUid: my5DigitUid, targetUid, customName });
    }

    if (e.target.id === "back-btn" || e.target.closest("#back-btn")) {
        currentTargetUid = null;
        document.getElementById("chat-screen")?.classList.add("hidden");
        document.getElementById("main-screen")?.classList.remove("hidden");
    }

    if (e.target.id === "send-btn" || e.target.closest("#send-btn")) sendMessageLogic();

    const text = e.target.innerText || "";
    if (text.includes("Video") || text.includes("Audio") || e.target.id === "video-call-btn" || e.target.id === "audio-call-btn") {
        if(!currentTargetUid) return alert("Call karne ke liye chat open karein!");
        currentCallType = text.includes("Video") ? "video" : "audio";
        activeCallTarget = currentTargetUid;

        let targetNameToShow = "Unknown person";
        const contact = myContacts.find(c => c.uid === currentTargetUid);
        if(contact) targetNameToShow = contact.name;

        document.getElementById("outgoing-call-name").innerHTML = `Calling ${targetNameToShow}...<br><span style="font-size:16px; color:#ccc;">${currentCallType} call</span>`;
        document.getElementById("outgoing-call-overlay").classList.remove("hidden");

        socket.emit("initiate_call", { callerUid: my5DigitUid, targetUid: currentTargetUid, callerName: currentUser.displayName, type: currentCallType });
    }

    if (e.target.id === "cancel-outgoing-btn") {
        document.getElementById("outgoing-call-overlay").classList.add("hidden");
        socket.emit("cancel_call", { targetUid: activeCallTarget });
        activeCallTarget = null;
    }

    if (e.target.id === "accept-call-btn") {
        document.getElementById("incoming-call-overlay").classList.add("hidden");
        socket.emit("call_response", { targetUid: activeCallTarget, status: "accepted" });
        startWebRTC(false);
    }

    if (e.target.id === "reject-call-btn") {
        document.getElementById("incoming-call-overlay").classList.add("hidden");
        socket.emit("call_response", { targetUid: activeCallTarget, status: "rejected" });
        activeCallTarget = null;
    }
    
    if (e.target.id === "end-call-btn") endCall();
});

document.addEventListener("keypress", (e) => {
    if (e.key === "Enter" && document.activeElement === document.getElementById("message-input")) {
        e.preventDefault(); 
        sendMessageLogic();
    }
});

socket.on("incoming_call", (data) => {
    activeCallTarget = data.callerUid;
    currentCallType = data.type; 
    
    let callerNameToShow = "Unknown person";
    const knownContact = myContacts.find(c => c.uid === data.callerUid);
    if (knownContact) {
        callerNameToShow = knownContact.name;
    }

    document.getElementById("caller-name-display").innerHTML = `${callerNameToShow}<br><span style="font-size:16px; color:#ccc;">Incoming ${currentCallType} call...</span>`;
    document.getElementById("incoming-call-overlay").classList.remove("hidden");
});

socket.on("call_cancelled", () => {
    document.getElementById("incoming-call-overlay").classList.add("hidden");
    activeCallTarget = null;
});

socket.on("call_response_received", (data) => {
    document.getElementById("outgoing-call-overlay").classList.add("hidden");
    if(data.status === "accepted") startWebRTC(true);
    else { alert("Saamne wale ne Call Reject kar di."); activeCallTarget = null; }
});

async function startWebRTC(isCaller) {
    document.getElementById("full-call-screen").classList.remove("hidden");
    const localVideo = document.getElementById("local-video");
    
    // FIX: Audio Call mein chota camera totally hide kar do
    if(currentCallType === "audio") {
        if(localVideo) localVideo.classList.add("hidden");
    } else {
        if(localVideo) localVideo.classList.remove("hidden");
    }
    
    try {
        const constraints = { audio: true, video: currentCallType === "video" };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if(localVideo && currentCallType === "video") { 
            localVideo.srcObject = localStream; 
        }
    } catch (err) { alert("Camera/Mic permission zaroori hai!"); endCall(); return; }
    
    peerConnection = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    peerConnection.ontrack = (event) => { const remote = document.getElementById("remote-video"); if(remote) remote.srcObject = event.streams[0]; };
    peerConnection.onicecandidate = (event) => { if(event.candidate) socket.emit("webrtc_ice_candidate", { targetUid: activeCallTarget, candidate: event.candidate }); };
    
    if(isCaller) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit("webrtc_offer", { targetUid: activeCallTarget, offer });
    }
}

socket.on("webrtc_offer_received", async (data) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("webrtc_answer", { targetUid: activeCallTarget, answer });
});
socket.on("webrtc_answer_received", async (data) => { await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer)); });
socket.on("webrtc_ice_candidate_received", async (data) => { if(peerConnection) await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); });

function endCall() {
    if(peerConnection) peerConnection.close();
    if(localStream) localStream.getTracks().forEach(track => track.stop());
    socket.emit("webrtc_end_call", { targetUid: activeCallTarget });
    activeCallTarget = null;
    document.getElementById("full-call-screen").classList.add("hidden");
}
socket.on("webrtc_call_ended", () => {
    if(peerConnection) peerConnection.close();
    if(localStream) localStream.getTracks().forEach(track => track.stop());
    document.getElementById("full-call-screen").classList.add("hidden");
    activeCallTarget = null;
});
