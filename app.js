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

// Client Firebase configuration from project zing-talk-c6496
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
    }, 3000);
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
        if (document.getElementById("my-uid")) document.getElementById("my-uid").innerText = "UID: " + my10DigitUid;
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
            <div style="padding: 40px 20px; text-align: center; color: #8696a0;">
                <svg width="48" height="48" fill="#d1d7db" viewBox="0 0 24 24" style="margin-bottom: 12px;"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                <p style="font-size: 15px; font-weight: 600; color: #54656f; margin-bottom: 6px;">No contacts added yet</p>
                <p style="font-size: 13px;">Ask your friend for their 10-digit UID and enter it above!</p>
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
                <span class="name-text" style="color: #111b21;">${contact.name}</span>
                <span class="contact-uid-sub">UID: ${contact.uid}</span>
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
            senderUid: my10DigitUid,
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

// ----------------- WebRTC Calling -----------------
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

// ----------------- Event Listeners -----------------
document.addEventListener("click", async (e) => {
    if (e.target.tagName === "BUTTON") e.preventDefault();

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

    // Toggle between Email Sign In and Register
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
                showToast("Google Sign-in failed: " + err.message);
            });
        } else {
            showLoginError("Firebase Auth is not initialized. Please try Guest login.");
        }
    }

    // Email & Password Auth Submit button
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

    // Open Profile Modal (clicking profile section or header profile button)
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

    // Close AdMob Interstitial Modal
    if (e.target.id === "admob-close-btn") {
        clearInterval(adTimerInterval);
        document.getElementById("admob-interstitial-modal")?.classList.add("hidden");
    }

    // Copy UID button inside Profile Modal
    if (e.target.id === "copy-uid-btn") {
        if (my10DigitUid) {
            navigator.clipboard.writeText(my10DigitUid).then(() => {
                showToast("10-Digit UID copied to clipboard: " + my10DigitUid);
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
        if (!targetUid || !customName) return showToast("Please enter UID and a custom name");
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
            outgoingName.innerHTML = `Calling ${targetNameToShow}...<br><span style="font-size:16px; color:#ccc;">${currentCallType} call</span>`;
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
    } else if (e.key === "Enter" && (document.activeElement === document.getElementById("email-input") || document.activeElement === document.getElementById("password-input"))) {
        e.preventDefault();
        document.getElementById("email-submit-btn")?.click();
    }
});
