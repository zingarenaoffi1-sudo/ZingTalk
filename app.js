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

let app, auth, provider;
try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    provider = new GoogleAuthProvider();
} catch (e) {
    console.warn("Firebase client init warning:", e);
}

// Connect Socket.IO to relative origin (runs on same host/port in AI Studio)
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
    }, 3000);
}

window.addEventListener("submit", (e) => e.preventDefault());

export let currentUser = null;
export let my5DigitUid = null;
export let currentTargetUid = null;
let chatHistory = JSON.parse(localStorage.getItem("zingTalkHistory")) || {};
let unreadCounts = {};
let myContacts = [];
let localStream = null;
let peerConnection = null;
let activeCallTarget = null;
let currentCallType = "video";
let iceCandidatesQueue = [];
const rtcConfig = {
    iceServers: [
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" }
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
        socket.emit("login_user", { email: user.email, name: user.displayName });
    }
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

if (socket) {
    socket.on("user_data", (data) => {
        my5DigitUid = data.uid;
        if (document.getElementById("my-name")) document.getElementById("my-name").innerText = currentUser.displayName;
        if (document.getElementById("my-uid")) document.getElementById("my-uid").innerText = "UID: " + my5DigitUid;
        if (document.getElementById("my-avatar")) document.getElementById("my-avatar").innerText = (currentUser.displayName || "U").charAt(0).toUpperCase();
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
        currentCallType = data.type;

        let callerNameToShow = "UID: " + data.callerUid;
        const knownContact = myContacts.find(c => c.uid === data.callerUid);
        if (knownContact) {
            callerNameToShow = knownContact.name;
        }

        const callerDisplay = document.getElementById("caller-name-display");
        if (callerDisplay) {
            callerDisplay.innerHTML = `${callerNameToShow}<br><span style="font-size:16px; color:#ccc;">Incoming ${currentCallType} call...</span>`;
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
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }
        document.getElementById("full-call-screen")?.classList.add("hidden");
        iceCandidatesQueue = [];
        activeCallTarget = null;
        showToast("Call ended");
    });
}

function renderContacts(contacts) {
    const contactsList = document.getElementById("contacts-list");
    if (!contactsList || !contacts) return;
    contactsList.innerHTML = "";
    myContacts = contacts;

    if (contacts.length === 0) {
        contactsList.innerHTML = `
            <div style="padding: 30px 20px; text-align: center; color: #888;">
                <p style="font-size: 15px; margin-bottom: 8px;">No contacts added yet</p>
                <p style="font-size: 13px; color: #aaa;">Enter a 5-digit UID and name above to start chatting!</p>
            </div>
        `;
        return;
    }

    contacts.forEach(contact => {
        const unreadCount = unreadCounts[contact.uid] || 0;
        const badge = unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : "";
        const div = document.createElement("div");
        div.className = "contact-item";
        div.innerHTML = `
            <div class="avatar small">${(contact.name || "U").charAt(0).toUpperCase()}</div>
            <div class="chat-contact-info">
                <span class="name-text">${contact.name}</span>
                <span style="font-size: 11px; color: #999;">UID: ${contact.uid}</span>
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
    if (document.getElementById("chat-avatar")) document.getElementById("chat-avatar").innerText = (contact.name || "U").charAt(0).toUpperCase();

    const chatMessagesArea = document.getElementById("messages-area") || document.querySelector(".messages-container");
    if (chatMessagesArea) {
        chatMessagesArea.innerHTML = "";
        if (chatHistory[contact.uid]) {
            chatHistory[contact.uid].forEach(msg => appendMessage(msg, msg.type));
        }
    }
}

function sendMessageLogic() {
    const messageInput = document.getElementById("message-input");
    const text = messageInput?.value.trim();
    if (text && currentTargetUid && socket) {
        const msgData = {
            senderUid: my5DigitUid,
            receiverUid: currentTargetUid,
            text: text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        socket.emit("send_message", msgData);
        appendMessage(msgData, "msg-sent");

        if (!chatHistory[currentTargetUid]) chatHistory[currentTargetUid] = [];
        chatHistory[currentTargetUid].push({ ...msgData, type: "msg-sent" });
        localStorage.setItem("zingTalkHistory", JSON.stringify(chatHistory));

        messageInput.value = "";
    }
}

function appendMessage(data, type) {
    const chatMessagesArea = document.getElementById("messages-area") || document.querySelector(".messages-container");
    if (!chatMessagesArea) return;
    const div = document.createElement("div");
    div.className = `msg-bubble ${type}`;
    div.innerHTML = `${escapeHtml(data.text)} <br><span style="font-size: 10px; color: gray; float: right; margin-top: 5px;">${data.timestamp}</span>`;
    chatMessagesArea.appendChild(div);
    chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

async function startWebRTC(isCaller) {
    document.getElementById("full-call-screen")?.classList.remove("hidden");
    const localVideo = document.getElementById("local-video");

    if (currentCallType === "audio") {
        if (localVideo) localVideo.classList.add("hidden");
    } else {
        if (localVideo) localVideo.classList.remove("hidden");
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

function endCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (socket && activeCallTarget) {
        socket.emit("webrtc_end_call", { targetUid: activeCallTarget });
    }
    activeCallTarget = null;
    iceCandidatesQueue = [];
    document.getElementById("full-call-screen")?.classList.add("hidden");
}

document.addEventListener("click", async (e) => {
    if (e.target.tagName === "BUTTON") e.preventDefault();

    // Google Login button
    if (e.target.id === "google-login-btn" || e.target.closest("#google-login-btn")) {
        if (auth && provider) {
            signInWithPopup(auth, provider).catch(err => {
                showToast("Google Login failed: " + err.message);
                const msgEl = document.getElementById("login-message");
                if (msgEl) {
                    msgEl.style.display = "block";
                    msgEl.innerText = "Google sign-in unavailable in this environment. Please use 'Start Chatting' as Guest above.";
                }
            });
        } else {
            showToast("Google Auth not available. Please continue as Guest.");
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

    // Save Contact button
    if (e.target.id === "save-contact-btn" || e.target.closest("#save-contact-btn")) {
        const targetUid = document.getElementById("search-uid-input")?.value.trim();
        const customName = document.getElementById("save-name-input")?.value.trim();
        if (targetUid === my5DigitUid) return showToast("You cannot save your own UID!");
        if (!targetUid || !customName) return showToast("Please enter UID and a name");
        if (socket) {
            socket.emit("save_contact", { myUid: my5DigitUid, targetUid, customName });
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

    // Call buttons (Audio / Video)
    const text = e.target.innerText || "";
    if (text.includes("Video") || text.includes("Audio") || e.target.id === "video-call-btn" || e.target.id === "audio-call-btn") {
        if (!currentTargetUid) return showToast("Please open a chat to make a call!");
        currentCallType = (text.includes("Video") || e.target.id === "video-call-btn") ? "video" : "audio";
        activeCallTarget = currentTargetUid;

        let targetNameToShow = "UID: " + currentTargetUid;
        const contact = myContacts.find(c => c.uid === currentTargetUid);
        if (contact) targetNameToShow = contact.name;

        const outgoingName = document.getElementById("outgoing-call-name");
        if (outgoingName) {
            outgoingName.innerHTML = `Calling ${targetNameToShow}...<br><span style="font-size:16px; color:#ccc;">${currentCallType} call</span>`;
        }
        document.getElementById("outgoing-call-overlay")?.classList.remove("hidden");

        if (socket) {
            socket.emit("initiate_call", {
                callerUid: my5DigitUid,
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

    // End Active Call button
    if (e.target.id === "end-call-btn" || e.target.closest("#end-call-btn")) {
        endCall();
    }
});

document.addEventListener("keypress", (e) => {
    if (e.key === "Enter" && document.activeElement === document.getElementById("message-input")) {
        e.preventDefault();
        sendMessageLogic();
    } else if (e.key === "Enter" && document.activeElement === document.getElementById("guest-name-input")) {
        e.preventDefault();
        document.getElementById("guest-login-btn")?.click();
    }
});
