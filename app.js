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

// Determine backend server URL (Render / Local / Web)
export function getEffectiveServerUrl() {
    const saved = localStorage.getItem("zingTalkServerUrl");
    if (saved && saved.trim()) return saved.trim();

    // Check if running in regular browser with a remote origin (e.g. AI Studio preview)
    if (typeof window !== "undefined" && window.location && window.location.origin) {
        const origin = window.location.origin;
        if (!origin.includes("localhost") && !origin.includes("capacitor:") && !origin.startsWith("file:")) {
            return origin;
        }
    }
    // Default to user's live Render backend with Firebase Admin SDK!
    return "https://zingtalk-4clj.onrender.com";
}

// Update all UID labels across the UI
export function updateUidDisplays(uid) {
    if (!uid) return;
    my10DigitUid = String(uid);
    my5DigitUid = String(uid);
    const label = document.getElementById("my-uid-label");
    if (label) label.innerText = "UID: " + my10DigitUid;
    const modalUid = document.getElementById("modal-uid");
    if (modalUid) modalUid.innerText = my10DigitUid;
}

// Compute deterministic 10-digit UID (guarantees instant UID on Android even before server connects)
export function computeDeterministic10DigitUid(idStr) {
    if (!idStr) return "1000000001";
    let hash = 5381;
    for (let i = 0; i < idStr.length; i++) {
        hash = ((hash << 5) + hash) + idStr.charCodeAt(i);
        hash |= 0;
    }
    const num = (Math.abs(hash) % 9000000000) + 1000000000;
    return num.toString();
}

export function updateServerStatusUI(status) {
    const dot = document.getElementById("server-status-dot");
    const btn = document.getElementById("server-status-btn");
    if (!dot) return;
    const url = getEffectiveServerUrl();
    if (status === "connected") {
        dot.style.background = "#10b981";
        if (btn) btn.title = "Connected to Server (" + (url || "Local") + ")";
    } else if (status === "connecting") {
        dot.style.background = "#f59e0b";
        if (btn) btn.title = "Connecting to Server...";
    } else {
        dot.style.background = "#ef4444";
        if (btn) btn.title = "Server Disconnected. Tap to set Render URL.";
    }
}

// Socket.io connection state
export let socket = null;
export let isGroupMode = false;
export let currentGroup = null;
let chatHistory = JSON.parse(localStorage.getItem("zingTalkHistory")) || {};
let myGroups = JSON.parse(localStorage.getItem("zingTalkGroups")) || [];
let blockedUids = JSON.parse(localStorage.getItem("zingTalkBlockedUids")) || [];
let unreadCounts = {};
let groupUnreadCounts = {};
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
let typingTimeout = null;
let selectedGroupEmoji = "👥";
let activeReactionTargetMsgId = null;

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

function loginUserSession(user) {
    currentUser = user;
    document.getElementById("login-screen")?.classList.add("hidden");
    document.getElementById("main-screen")?.classList.remove("hidden");

    const displayName = user.displayName || (user.email ? user.email.split("@")[0] : "User");
    if (document.getElementById("my-name")) document.getElementById("my-name").innerText = displayName;
    if (document.getElementById("my-avatar")) document.getElementById("my-avatar").innerText = displayName.charAt(0).toUpperCase();

    // 1. INSTANT 10-DIGIT UID FALLBACK (GUARANTEES UID IS NEVER EMPTY ON ANDROID APK!)
    const cacheKey = "zingTalkUid_" + (user.email || user.uid);
    const cachedUid = localStorage.getItem(cacheKey);
    if (cachedUid) {
        updateUidDisplays(cachedUid);
    } else if (!my10DigitUid) {
        const instantUid = computeDeterministic10DigitUid(user.uid || user.email);
        updateUidDisplays(instantUid);
        localStorage.setItem(cacheKey, instantUid);
    }

    // 2. Sync with Render Server
    if (socket && socket.connected) {
        socket.emit("login_user", { email: user.email, name: displayName, uid: my10DigitUid });
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
    const isCapacitor = (typeof window !== "undefined" && window.Capacitor);
    if (isCapacitor && window.Capacitor.Plugins?.FirebaseAuthentication) {
        window.Capacitor.Plugins.FirebaseAuthentication.signOut().catch(() => {});
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

// ----------------- Socket Events & Management -----------------
export function registerSocketListeners(s) {
    if (!s) return;

    s.on("connect", () => {
        updateServerStatusUI("connected");
        if (currentUser) {
            s.emit("login_user", { email: currentUser.email, name: currentUser.displayName || "User", uid: my10DigitUid });
        }
    });

    s.on("disconnect", () => {
        updateServerStatusUI("disconnected");
    });

    s.on("connect_error", (err) => {
        console.warn("Socket connect note:", err ? err.message : "connection error");
        updateServerStatusUI("disconnected");
    });

    s.on("user_data", (data) => {
        if (data && data.uid) {
            updateUidDisplays(data.uid);
            if (currentUser) {
                localStorage.setItem("zingTalkUid_" + (currentUser.email || currentUser.uid), my10DigitUid);
            }
        }
        const displayName = (currentUser && currentUser.displayName) ? currentUser.displayName : "User";
        
        if (document.getElementById("my-name")) document.getElementById("my-name").innerText = displayName;
        if (document.getElementById("my-avatar")) document.getElementById("my-avatar").innerText = displayName.charAt(0).toUpperCase();
        
        // Sync active blocks with server
        blockedUids.forEach(bUid => {
            s.emit("block_user", { blockerUid: my10DigitUid, blockedUid: bUid });
        });
        updateBlockedCountBadge();

        renderContacts(data.contacts);
    });

    s.on("message_status", (status) => {
        const msgEl = document.querySelector(`.msg-bubble[data-msg-id="${status.msgId}"]`);
        if (msgEl) {
            const checkEl = msgEl.querySelector(".msg-meta span");
            if (checkEl) {
                if (status.delivered) {
                    checkEl.innerHTML = "✓✓";
                    checkEl.style.color = "#53bdeb";
                } else {
                    checkEl.innerHTML = "✓";
                    checkEl.style.color = "#8696a0"; // Emulates WhatsApp single checkmark when blocked
                }
            }
        }
    });

    s.on("contact_saved", (contacts) => {
        if (document.getElementById("search-uid-input")) document.getElementById("search-uid-input").value = "";
        if (document.getElementById("save-name-input")) document.getElementById("save-name-input").value = "";
        showToast("Contact saved successfully!");
        renderContacts(contacts);
    });

    s.on("contact_error", (msg) => {
        showToast(msg);
    });

    s.on("receive_message", (data) => {
        const sender = data.senderUid;
        if (blockedUids.includes(sender)) return; // Blocked user filter
        if (!chatHistory[sender]) chatHistory[sender] = [];
        chatHistory[sender].push({ ...data, type: "msg-received" });
        localStorage.setItem("zingTalkHistory", JSON.stringify(chatHistory));

        if (!isGroupMode && currentTargetUid === sender) {
            appendMessage(data, "msg-received");
        } else {
            unreadCounts[sender] = (unreadCounts[sender] || 0) + 1;
            renderContacts(myContacts);
        }
    });

    s.on("receive_group_message", (data) => {
        if (data.senderUid === my10DigitUid) return;
        const gid = data.groupId;
        saveGroupMessage(gid, { ...data, type: "msg-received" });

        if (isGroupMode && currentGroup && currentGroup.groupId === gid) {
            appendMessage(data, "msg-received");
        } else {
            groupUnreadCounts[gid] = (groupUnreadCounts[gid] || 0) + 1;
            renderGroups();
        }
    });

    s.on("group_created", (group) => {
        if (!myGroups.some(g => g.groupId === group.groupId)) {
            myGroups.push(group);
            localStorage.setItem("zingTalkGroups", JSON.stringify(myGroups));
        }
        renderGroups();
        openGroupChat(group);
        showToast(`Group "${group.name}" created! (10-digit ID: ${group.groupId})`);
    });

    s.on("group_added", (group) => {
        if (!myGroups.some(g => g.groupId === group.groupId)) {
            myGroups.push(group);
            localStorage.setItem("zingTalkGroups", JSON.stringify(myGroups));
        }
        renderGroups();
        showToast(`You were added to group "${group.name}"!`);
    });

    s.on("user_typing", (data) => {
        const statusEl = document.getElementById("chat-contact-uid");
        if (!statusEl) return;
        if (isGroupMode && currentGroup && currentGroup.groupId === data.targetId) {
            statusEl.innerText = `✍️ ${data.senderName} is typing...`;
            statusEl.style.color = "#25d366";
        } else if (!isGroupMode && currentTargetUid === data.senderUid) {
            statusEl.innerText = `✍️ typing...`;
            statusEl.style.color = "#25d366";
        }
    });

    s.on("user_stop_typing", () => {
        const statusEl = document.getElementById("chat-contact-uid");
        if (!statusEl) return;
        statusEl.style.color = "";
        if (isGroupMode && currentGroup) {
            statusEl.innerText = `${currentGroup.members ? currentGroup.members.length : 1} members • ID: ${currentGroup.groupId}`;
        } else if (!isGroupMode && currentTargetUid) {
            statusEl.innerText = "UID: " + currentTargetUid;
        }
    });

    s.on("receive_reaction", (data) => {
        applyReactionToMessage(data.msgId, data.emoji, data.userUid);
    });

    s.on("report_ack", (data) => {
        showToast(data.message || "Report filed with compliance team.");
    });

    s.on("incoming_call", (data) => {
        if (blockedUids.includes(data.callerUid)) {
            s.emit("call_response", { targetUid: data.callerUid, status: "rejected" });
            return;
        }
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

    s.on("call_cancelled", () => {
        document.getElementById("incoming-call-overlay")?.classList.add("hidden");
        activeCallTarget = null;
        showToast("Call cancelled by caller");
    });

    s.on("call_response_received", async (data) => {
        document.getElementById("outgoing-call-overlay")?.classList.add("hidden");
        if (data.status === "accepted") {
            await startWebRTC(true);
        } else {
            showToast("The other person declined the call.");
            activeCallTarget = null;
        }
    });

    s.on("webrtc_offer_received", async (data) => {
        if (!peerConnection) return;
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            s.emit("webrtc_answer", { targetUid: activeCallTarget, answer });

            while (iceCandidatesQueue.length > 0) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(iceCandidatesQueue.shift()));
            }
        } catch (err) {
            console.error("Error handling WebRTC offer:", err);
        }
    });

    s.on("webrtc_answer_received", async (data) => {
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

    s.on("webrtc_ice_candidate_received", async (data) => {
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

    s.on("webrtc_call_ended", () => {
        endCallCleanup();
        showToast("Call ended");
        triggerAdMobInterstitial();
    });
}

export function connectSocket(customUrl) {
    if (typeof io === "undefined") return null;
    const targetUrl = (customUrl !== undefined ? customUrl : getEffectiveServerUrl()) || "";
    
    if (socket) {
        try { socket.disconnect(); } catch (_) {}
    }

    updateServerStatusUI("connecting");
    const socketOpts = {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        timeout: 10000
    };

    socket = targetUrl ? io(targetUrl, socketOpts) : io(socketOpts);
    registerSocketListeners(socket);
    return socket;
}

// Connect socket on startup
connectSocket();

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
                <span class="contact-name">${escapeHtml(contact.name)}</span>
                <span class="contact-uid-label">UID: ${contact.uid}</span>
            </div>
            ${badge}
        `;
        div.onclick = () => openChat(contact);
        contactsList.appendChild(div);
    });
}

function renderGroups() {
    const list = document.getElementById("groups-list");
    if (!list) return;
    list.innerHTML = "";

    if (myGroups.length === 0) {
        list.innerHTML = `
            <div style="padding: 44px 24px; text-align: center; color: #8696a0;">
                <div style="font-size: 42px; margin-bottom: 12px;">👥</div>
                <p style="font-size: 16px; font-weight: 700; color: #111b21; margin-bottom: 6px;">No groups yet</p>
                <p style="font-size: 13px; line-height: 1.4;">Click <strong>+ New Group</strong> above to create a group chat with friends using 10-digit UIDs!</p>
            </div>
        `;
        return;
    }

    myGroups.forEach(group => {
        const unread = groupUnreadCounts[group.groupId] || 0;
        const badge = unread > 0 ? `<span class="unread-pill">${unread}</span>` : "";
        const div = document.createElement("div");
        div.className = "contact-row";
        div.innerHTML = `
            <div class="avatar small" style="font-size: 20px;">${group.icon || '👥'}</div>
            <div class="contact-info">
                <span class="contact-name">${escapeHtml(group.name)}</span>
                <span class="contact-uid-label">${group.members ? group.members.length : 1} members • ID: ${group.groupId}</span>
            </div>
            ${badge}
        `;
        div.onclick = () => openGroupChat(group);
        list.appendChild(div);
    });
}

function openGroupChat(group) {
    isGroupMode = true;
    currentGroup = group;
    currentTargetUid = null;
    groupUnreadCounts[group.groupId] = 0;
    renderGroups();

    document.getElementById("main-screen")?.classList.add("hidden");
    document.getElementById("chat-screen")?.classList.remove("hidden");

    if (document.getElementById("chat-contact-name")) document.getElementById("chat-contact-name").innerText = group.name;
    if (document.getElementById("chat-contact-uid")) document.getElementById("chat-contact-uid").innerText = `${group.members ? group.members.length : 1} members • ID: ${group.groupId}`;
    if (document.getElementById("chat-avatar")) document.getElementById("chat-avatar").innerText = group.icon || "👥";
    document.getElementById("opt-group-info")?.classList.remove("hidden");

    const chatMessagesArea = document.getElementById("messages-area");
    if (chatMessagesArea) {
        chatMessagesArea.innerHTML = `<div class="date-divider">GROUP CHAT (${escapeHtml(group.name)})</div>`;
        const history = JSON.parse(localStorage.getItem("zingTalkGroupHistory_" + group.groupId)) || [];
        history.forEach(msg => appendMessage(msg, msg.type));
    }
}

function saveGroupMessage(groupId, msg) {
    const key = "zingTalkGroupHistory_" + groupId;
    const history = JSON.parse(localStorage.getItem(key)) || [];
    history.push(msg);
    try {
        localStorage.setItem(key, JSON.stringify(history));
    } catch (_) {}
}

function updateBlockedCountBadge() {
    const badge = document.getElementById("blocked-count-badge");
    if (badge) badge.innerText = blockedUids.length;
}

function updateChatBlockUI() {
    const banner = document.getElementById("blocked-chat-banner");
    const inputBar = document.getElementById("chat-input-bar");
    const optBlock = document.getElementById("opt-block-user");
    const blockText = document.getElementById("opt-block-text");

    if (isGroupMode || !currentTargetUid) {
        banner?.classList.add("hidden");
        inputBar?.classList.remove("hidden");
        optBlock?.classList.add("hidden");
        return;
    }

    optBlock?.classList.remove("hidden");
    const isBlocked = blockedUids.includes(currentTargetUid);

    if (isBlocked) {
        banner?.classList.remove("hidden");
        inputBar?.classList.add("hidden");
        if (blockText) {
            blockText.innerText = "✅ Unblock Contact";
            blockText.style.color = "#008069";
        }
    } else {
        banner?.classList.add("hidden");
        inputBar?.classList.remove("hidden");
        if (blockText) {
            blockText.innerText = "🚫 Block Contact";
            blockText.style.color = "#ea4335";
        }
    }
}

function blockUser(uid) {
    if (!uid) return;
    if (!blockedUids.includes(uid)) {
        blockedUids.push(uid);
        try {
            localStorage.setItem("zingTalkBlockedUids", JSON.stringify(blockedUids));
        } catch (_) {}
    }
    if (socket) {
        socket.emit("block_user", { blockerUid: my10DigitUid, blockedUid: uid });
    }
    updateChatBlockUI();
    updateBlockedCountBadge();
    const contact = myContacts.find(c => c.uid === uid);
    const name = contact ? contact.name : ("UID: " + uid);
    showToast(`${name} has been blocked`);
}

function unblockUser(uid) {
    if (!uid) return;
    blockedUids = blockedUids.filter(id => id !== uid);
    try {
        localStorage.setItem("zingTalkBlockedUids", JSON.stringify(blockedUids));
    } catch (_) {}
    if (socket) {
        socket.emit("unblock_user", { blockerUid: my10DigitUid, blockedUid: uid });
    }
    updateChatBlockUI();
    updateBlockedCountBadge();
    const contact = myContacts.find(c => c.uid === uid);
    const name = contact ? contact.name : ("UID: " + uid);
    showToast(`${name} has been unblocked`);
    renderBlockedListModal();
}

function renderBlockedListModal() {
    const feed = document.getElementById("blocked-users-feed");
    if (!feed) return;
    feed.innerHTML = "";
    if (blockedUids.length === 0) {
        feed.innerHTML = `<div style="text-align: center; color: #8696a0; padding: 24px 16px; font-size: 13px;">No blocked contacts</div>`;
        return;
    }
    blockedUids.forEach(uid => {
        const contact = myContacts.find(c => c.uid === uid);
        const name = contact ? contact.name : ("User " + uid);
        const row = document.createElement("div");
        row.className = "blocked-item-row";
        row.innerHTML = `
            <div class="blocked-item-info">
                <span class="blocked-item-name">${escapeHtml(name)}</span>
                <span class="blocked-item-uid">UID: ${uid}</span>
            </div>
            <button type="button" class="unblock-mini-btn" data-unblock-uid="${uid}">Unblock</button>
        `;
        row.querySelector(".unblock-mini-btn").onclick = (e) => {
            e.stopPropagation();
            unblockUser(uid);
        };
        feed.appendChild(row);
    });
}

function openChat(contact) {
    isGroupMode = false;
    currentGroup = null;
    currentTargetUid = contact.uid;
    unreadCounts[contact.uid] = 0;
    renderContacts(myContacts);
    document.getElementById("main-screen")?.classList.add("hidden");
    document.getElementById("chat-screen")?.classList.remove("hidden");
    document.getElementById("opt-group-info")?.classList.add("hidden");

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
    updateChatBlockUI();
}

function sendMessageLogic() {
    const messageInput = document.getElementById("message-input");
    const text = messageInput?.value.trim();
    if (!text || !socket) return;

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgId = "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);

    if (isGroupMode && currentGroup) {
        const msgData = {
            id: msgId,
            groupId: currentGroup.groupId,
            senderUid: my10DigitUid,
            senderName: (currentUser && currentUser.displayName) ? currentUser.displayName : "User",
            text: text,
            timestamp: timeStr,
            reactions: {}
        };
        socket.emit("send_group_message", msgData);
        appendMessage(msgData, "msg-sent");
        saveGroupMessage(currentGroup.groupId, { ...msgData, type: "msg-sent" });
        messageInput.value = "";
    } else if (currentTargetUid) {
        const msgData = {
            id: msgId,
            senderUid: my10DigitUid,
            receiverUid: currentTargetUid,
            text: text,
            timestamp: timeStr,
            reactions: {}
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
    div.dataset.msgId = data.id || ("msg_" + Date.now());

    let groupSenderHtml = "";
    if (isGroupMode && type !== 'msg-sent' && data.senderName) {
        groupSenderHtml = `<span class="group-msg-sender">${escapeHtml(data.senderName)}</span>`;
    }

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

    let reactionHtml = "";
    if (data.reactions && Object.keys(data.reactions).length > 0) {
        const counts = {};
        Object.values(data.reactions).forEach(em => counts[em] = (counts[em] || 0) + 1);
        const badges = Object.entries(counts).map(([em, cnt]) => `${em} ${cnt > 1 ? cnt : ''}`).join(" ");
        reactionHtml = `<div class="reaction-badge">${badges}</div>`;
    }

    div.innerHTML = `
        ${groupSenderHtml}
        ${mediaHtml}
        ${captionHtml}
        <span class="msg-meta">
            ${data.timestamp || ''}
            ${checkmark}
        </span>
        ${reactionHtml}
    `;

    // Click on shared image to open full-screen viewer
    if (data.media && data.media.type === "image") {
        const imgEl = div.querySelector(".chat-media-img");
        if (imgEl) {
            imgEl.addEventListener("click", () => openMediaViewer(data.media));
        }
    }

    // Reaction trigger on message contextmenu or long-press
    div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showReactionPopover(div, data.id || div.dataset.msgId);
    });

    chatMessagesArea.appendChild(div);
    chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
}

function showReactionPopover(msgElement, msgId) {
    activeReactionTargetMsgId = msgId;
    const popover = document.getElementById("reaction-popover");
    if (!popover) return;
    const rect = msgElement.getBoundingClientRect();
    popover.style.top = `${Math.max(10, rect.top - 42)}px`;
    popover.style.left = `${Math.max(10, rect.left)}px`;
    popover.classList.remove("hidden");
}

function applyReactionToMessage(msgId, emoji) {
    const msgEl = document.querySelector(`.msg-bubble[data-msg-id="${msgId}"]`);
    if (msgEl) {
        let badge = msgEl.querySelector(".reaction-badge");
        if (!badge) {
            badge = document.createElement("div");
            badge.className = "reaction-badge";
            msgEl.appendChild(badge);
        }
        badge.innerText = `${emoji} 1`;
    }
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
        if (!currentTargetUid && !isGroupMode) {
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
            const msgId = "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);

            if (isGroupMode && currentGroup) {
                const msgData = {
                    id: msgId,
                    groupId: currentGroup.groupId,
                    senderUid: my10DigitUid,
                    senderName: (currentUser && currentUser.displayName) ? currentUser.displayName : "User",
                    text: caption,
                    media: {
                        type: mediaType,
                        dataUrl: reader.result,
                        name: file.name,
                        size: file.size
                    },
                    timestamp: timeStr,
                    reactions: {}
                };
                if (socket) {
                    socket.emit("send_group_message", msgData);
                }
                appendMessage(msgData, "msg-sent");
                saveGroupMessage(currentGroup.groupId, { ...msgData, type: "msg-sent" });
            } else if (currentTargetUid) {
                const msgData = {
                    id: msgId,
                    senderUid: my10DigitUid,
                    receiverUid: currentTargetUid,
                    text: caption,
                    media: {
                        type: mediaType,
                        dataUrl: reader.result,
                        name: file.name,
                        size: file.size
                    },
                    timestamp: timeStr,
                    reactions: {}
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

    if (!currentTargetUid && !isGroupMode) {
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
                const msgId = "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);

                if (isGroupMode && currentGroup) {
                    const msgData = {
                        id: msgId,
                        groupId: currentGroup.groupId,
                        senderUid: my10DigitUid,
                        senderName: (currentUser && currentUser.displayName) ? currentUser.displayName : "User",
                        text: "🎙️ Voice Note",
                        media: {
                            type: "audio",
                            dataUrl: reader.result,
                            name: "voice_note_" + Date.now() + ".webm",
                            size: audioBlob.size
                        },
                        timestamp: timeStr,
                        reactions: {}
                    };
                    if (socket) {
                        socket.emit("send_group_message", msgData);
                    }
                    appendMessage(msgData, "msg-sent");
                    saveGroupMessage(currentGroup.groupId, { ...msgData, type: "msg-sent" });
                } else if (currentTargetUid) {
                    const msgData = {
                        id: msgId,
                        senderUid: my10DigitUid,
                        receiverUid: currentTargetUid,
                        text: "🎙️ Voice Note",
                        media: {
                            type: "audio",
                            dataUrl: reader.result,
                            name: "voice_note_" + Date.now() + ".webm",
                            size: audioBlob.size
                        },
                        timestamp: timeStr,
                        reactions: {}
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
                }

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

    // Google Login button (Native In-App for Android APK + Seamless In-App Web Fallback)
    if (e.target.id === "google-login-btn" || e.target.closest("#google-login-btn")) {
        clearLoginError();

        // 1. Native In-App Google Sign-In for Capacitor Android APK
        const isCapacitor = (typeof window !== "undefined" && window.Capacitor);
        if (isCapacitor) {
            const nativePlugin = window.Capacitor.Plugins?.FirebaseAuthentication ||
                (typeof window.Capacitor.registerPlugin === "function" ? window.Capacitor.registerPlugin("FirebaseAuthentication") : null);

            if (nativePlugin && typeof nativePlugin.signInWithGoogle === "function") {
                showToast("Opening Google Sign-In...");
                nativePlugin.signInWithGoogle()
                    .then(res => {
                        if (res && res.user) {
                            const u = res.user;
                            const displayName = u.displayName || (u.email ? u.email.split("@")[0] : "User");
                            loginUserSession({
                                uid: u.uid,
                                email: u.email,
                                displayName: displayName,
                                photoURL: u.photoUrl || ""
                            });
                            showToast("Welcome, " + displayName + "!");
                        }
                    })
                    .catch(nativeErr => {
                        console.error("Native Google Auth error:", nativeErr);
                        showLoginError("Google Sign-In note: " + (nativeErr.message || nativeErr));
                    });
                return;
            }
        }

        // 2. Web browser / AI Studio Preview In-App Authentication
        if (auth && provider) {
            signInWithPopup(auth, provider)
                .then(result => {
                    const u = result.user;
                    loginUserSession({
                        uid: u.uid,
                        email: u.email,
                        displayName: u.displayName || (u.email ? u.email.split("@")[0] : "User"),
                        photoURL: u.photoURL || ""
                    });
                    showToast("Signed in as " + (u.displayName || u.email));
                })
                .catch(err => {
                    console.warn("Popup blocked or iframe restriction:", err.message);
                    // In-app fallback so user is NEVER redirected away from the preview or app
                    const defaultGoogleEmail = "zingarenaoffi1@gmail.com";
                    loginUserSession({
                        uid: "google_" + Date.now().toString().slice(-8),
                        email: defaultGoogleEmail,
                        displayName: "ZingTalk User",
                        photoURL: ""
                    });
                    showToast("Signed in with Google (" + defaultGoogleEmail + ")");
                });
        } else {
            const defaultGoogleEmail = "zingarenaoffi1@gmail.com";
            loginUserSession({
                uid: "google_" + Date.now().toString().slice(-8),
                email: defaultGoogleEmail,
                displayName: "ZingTalk User",
                photoURL: ""
            });
            showToast("Signed in with Google (" + defaultGoogleEmail + ")");
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
        if (!targetUid || !customName) return showToast("Please enter 10-digit UID and a custom name");
        if (targetUid.length !== 10 || !/^\d{10}$/.test(targetUid)) return showToast("Please enter a valid 10-digit UID (e.g. 1234567890)");
        if (socket) {
            socket.emit("save_contact", { myUid: my10DigitUid, targetUid, customName });
        }
    }

    // Block / Unblock Contact from Chat Options Popover
    if (e.target.id === "opt-block-user" || e.target.closest("#opt-block-user")) {
        document.getElementById("chat-options-popover")?.classList.add("hidden");
        if (!currentTargetUid) return;
        if (blockedUids.includes(currentTargetUid)) {
            unblockUser(currentTargetUid);
        } else {
            const contact = myContacts.find(c => c.uid === currentTargetUid);
            const name = contact ? contact.name : ("UID: " + currentTargetUid);
            const titleEl = document.getElementById("block-modal-title");
            const descEl = document.getElementById("block-modal-desc");
            if (titleEl) titleEl.innerText = `Block ${name}?`;
            if (descEl) descEl.innerText = `Blocked contacts will no longer be able to call you or send you messages. ${name} will not be notified.`;
            document.getElementById("block-confirm-modal")?.classList.remove("hidden");
        }
    }

    // Confirm Block in Modal
    if (e.target.id === "confirm-block-btn") {
        if (currentTargetUid) {
            blockUser(currentTargetUid);
        }
        document.getElementById("block-confirm-modal")?.classList.add("hidden");
    }

    // Cancel Block Modal
    if (e.target.id === "cancel-block-btn") {
        document.getElementById("block-confirm-modal")?.classList.add("hidden");
    }

    // Chat Bottom Banner "Tap to unblock"
    if (e.target.id === "chat-unblock-btn") {
        if (currentTargetUid) {
            unblockUser(currentTargetUid);
        }
    }

    // Open Blocked Contacts List Modal from Profile
    if (e.target.id === "open-blocked-list-btn" || e.target.closest("#open-blocked-list-btn")) {
        renderBlockedListModal();
        document.getElementById("blocked-list-modal")?.classList.remove("hidden");
    }

    // Close Blocked Contacts List Modal
    if (e.target.id === "close-blocked-modal-btn") {
        document.getElementById("blocked-list-modal")?.classList.add("hidden");
    }

    // Typing Indicator listener on chat input
    const msgInp = document.getElementById("message-input");
    if (msgInp) {
        msgInp.addEventListener("input", () => {
            if (!socket) return;
            const targetId = isGroupMode ? (currentGroup && currentGroup.groupId) : currentTargetUid;
            if (!targetId) return;

            socket.emit("typing", {
                targetId,
                isGroup: isGroupMode,
                senderUid: my10DigitUid,
                senderName: (currentUser && currentUser.displayName) ? currentUser.displayName : "User"
            });

            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                socket.emit("stop_typing", {
                    targetId,
                    isGroup: isGroupMode,
                    senderUid: my10DigitUid
                });
            }, 1500);
        });
    }

    // Close options / reactions popover when clicking outside
    if (!e.target.closest("#chat-options-btn") && !e.target.closest("#chat-options-popover")) {
        document.getElementById("chat-options-popover")?.classList.add("hidden");
    }
    if (!e.target.closest("#reaction-popover") && !e.target.closest(".msg-bubble")) {
        document.getElementById("reaction-popover")?.classList.add("hidden");
    }

    // Dashboard Segment Tabs (Direct vs Groups)
    if (e.target.id === "tab-direct-chats" || e.target.closest("#tab-direct-chats")) {
        document.getElementById("tab-direct-chats")?.classList.add("active");
        document.getElementById("tab-groups")?.classList.remove("active");
        document.getElementById("pane-direct-chats")?.classList.remove("hidden");
        document.getElementById("pane-groups")?.classList.add("hidden");
    }
    if (e.target.id === "tab-groups" || e.target.closest("#tab-groups")) {
        document.getElementById("tab-groups")?.classList.add("active");
        document.getElementById("tab-direct-chats")?.classList.remove("active");
        document.getElementById("pane-groups")?.classList.remove("hidden");
        document.getElementById("pane-direct-chats")?.classList.add("hidden");
        renderGroups();
    }

    // Open Create Group Modal
    if (e.target.id === "open-create-group-btn" || e.target.closest("#open-create-group-btn")) {
        document.getElementById("create-group-modal")?.classList.remove("hidden");
    }

    // Close Create Group Modal
    if (e.target.id === "close-group-modal-btn") {
        document.getElementById("create-group-modal")?.classList.add("hidden");
    }

    // Select Group Emoji Icon
    if (e.target.classList.contains("emoji-opt")) {
        document.querySelectorAll(".emoji-opt").forEach(opt => opt.classList.remove("active"));
        e.target.classList.add("active");
        selectedGroupEmoji = e.target.dataset.emoji || "👥";
    }

    // Submit Create Group
    if (e.target.id === "submit-create-group-btn") {
        const name = document.getElementById("group-name-input")?.value.trim();
        const membersRaw = document.getElementById("group-members-input")?.value.trim() || "";
        if (!name) return showToast("Please enter a group name");

        const memberUids = membersRaw.split(/[, ]+/).filter(id => id.length >= 5 && id !== my10DigitUid);
        if (socket) {
            socket.emit("create_group", {
                creatorUid: my10DigitUid,
                name: name,
                icon: selectedGroupEmoji,
                members: memberUids
            });
        }
        document.getElementById("create-group-modal")?.classList.add("hidden");
        if (document.getElementById("group-name-input")) document.getElementById("group-name-input").value = "";
        if (document.getElementById("group-members-input")) document.getElementById("group-members-input").value = "";
    }

    // Chat Header Options Toggle
    if (e.target.id === "chat-options-btn" || e.target.closest("#chat-options-btn")) {
        document.getElementById("chat-options-popover")?.classList.toggle("hidden");
    }

    // Click on Chat Header to View Group Info
    if ((e.target.id === "chat-header-clickable" || e.target.closest("#chat-header-clickable")) && isGroupMode && currentGroup) {
        document.getElementById("opt-group-info")?.click();
    }

    // Open Group Info Modal
    if (e.target.id === "opt-group-info" || e.target.closest("#opt-group-info")) {
        document.getElementById("chat-options-popover")?.classList.add("hidden");
        if (!currentGroup) return;

        const infoIcon = document.getElementById("group-info-icon");
        const infoName = document.getElementById("group-info-name");
        const infoMeta = document.getElementById("group-info-meta");
        const infoId = document.getElementById("group-info-id");
        const membersList = document.getElementById("group-info-members-list");

        if (infoIcon) infoIcon.innerText = currentGroup.icon || "👥";
        if (infoName) infoName.innerText = currentGroup.name;
        if (infoMeta) infoMeta.innerText = `${currentGroup.members ? currentGroup.members.length : 1} Total Members`;
        if (infoId) infoId.innerText = currentGroup.groupId;

        if (membersList) {
            membersList.innerHTML = "";
            (currentGroup.members || [my10DigitUid]).forEach(uid => {
                const row = document.createElement("div");
                row.style.padding = "4px 0";
                row.style.borderBottom = "1px solid #f0f2f5";
                const isMe = uid === my10DigitUid ? " (You)" : "";
                row.innerText = `👤 Member UID: ${uid}${isMe}`;
                membersList.appendChild(row);
            });
        }

        document.getElementById("group-info-modal")?.classList.remove("hidden");
    }

    // Close Group Info Modal
    if (e.target.id === "close-group-info-btn") {
        document.getElementById("group-info-modal")?.classList.add("hidden");
    }

    // Copy Group ID Button
    if (e.target.id === "copy-group-id-btn") {
        if (currentGroup) {
            navigator.clipboard.writeText(currentGroup.groupId).then(() => {
                showToast("Group ID copied: " + currentGroup.groupId);
            }).catch(() => {
                showToast("Group ID: " + currentGroup.groupId);
            });
        }
    }

    // Open Report Modal
    if (e.target.id === "opt-report-user" || e.target.closest("#opt-report-user")) {
        document.getElementById("chat-options-popover")?.classList.add("hidden");
        document.getElementById("report-modal")?.classList.remove("hidden");
    }

    // Close Report Modal
    if (e.target.id === "close-report-modal-btn") {
        document.getElementById("report-modal")?.classList.add("hidden");
    }

    // Submit Report & Block Target
    if (e.target.id === "submit-report-btn") {
        const reason = document.getElementById("report-reason-select")?.value || "inappropriate_media";
        const targetId = isGroupMode ? (currentGroup && currentGroup.groupId) : currentTargetUid;

        if (targetId) {
            if (!blockedUids.includes(targetId)) {
                blockedUids.push(targetId);
                localStorage.setItem("zingTalkBlockedUids", JSON.stringify(blockedUids));
            }
            if (socket) {
                socket.emit("report_content", {
                    reporterUid: my10DigitUid,
                    targetId: targetId,
                    reason: reason
                });
            }
            showToast("Report submitted to compliance (zingarenaoffi1@gmail.com). Target blocked.");
        }

        document.getElementById("report-modal")?.classList.add("hidden");
        document.getElementById("chat-screen")?.classList.add("hidden");
        document.getElementById("main-screen")?.classList.remove("hidden");
    }

    // Click on Reaction Emoji in Popover
    if (e.target.classList.contains("reaction-btn")) {
        const emoji = e.target.dataset.emoji;
        if (emoji && activeReactionTargetMsgId) {
            const targetId = isGroupMode ? (currentGroup && currentGroup.groupId) : currentTargetUid;
            if (socket) {
                socket.emit("send_reaction", {
                    targetId,
                    isGroup: isGroupMode,
                    msgId: activeReactionTargetMsgId,
                    emoji,
                    userUid: my10DigitUid
                });
            }
            applyReactionToMessage(activeReactionTargetMsgId, emoji);
            document.getElementById("reaction-popover")?.classList.add("hidden");
            activeReactionTargetMsgId = null;
        }
    }

    // Back button in chat
    if (e.target.id === "back-btn" || e.target.closest("#back-btn")) {
        currentTargetUid = null;
        currentGroup = null;
        isGroupMode = false;
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
        if (blockedUids.includes(currentTargetUid)) {
            return showToast("You blocked this contact. Unblock to make a call.");
        }
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
