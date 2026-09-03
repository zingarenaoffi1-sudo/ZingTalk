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

const loginScreen = document.getElementById("login-screen");
const mainScreen = document.getElementById("main-screen");
const chatScreen = document.getElementById("chat-screen");
const loginBtn = document.getElementById("google-login-btn");
const myAvatar = document.getElementById("my-avatar");
const myName = document.getElementById("my-name");
const myUid = document.getElementById("my-uid");
const searchUidInput = document.getElementById("search-uid-input");
const saveNameInput = document.getElementById("save-name-input");
const saveContactBtn = document.getElementById("save-contact-btn");
const contactsList = document.getElementById("contacts-list");
const backBtn = document.getElementById("back-btn");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const chatMessagesArea = document.getElementById("chat-messages");

let currentUser = null;
export let my5DigitUid = null;
export let currentTargetUid = null;

let chatHistory = {};
let unreadCounts = {};
let myContacts = [];

loginBtn.addEventListener("click", () => {
    signInWithPopup(auth, provider).catch(err => alert(err.message));
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        loginScreen.classList.add("hidden");
        mainScreen.classList.remove("hidden");
        
        socket.emit("login_user", {
            email: user.email,
            name: user.displayName
        });
    } else {
        loginScreen.classList.remove("hidden");
        mainScreen.classList.add("hidden");
        chatScreen.classList.add("hidden");
    }
});

socket.on("user_data", (data) => {
    my5DigitUid = data.uid;
    myContacts = data.contacts || [];
    myName.innerText = currentUser.displayName;
    myUid.innerText = "UID: " + my5DigitUid;
    myAvatar.innerText = currentUser.displayName.charAt(0).toUpperCase();
    
    renderContacts(myContacts);
});

saveContactBtn.addEventListener("click", () => {
    const targetUid = searchUidInput.value.trim();
    const customName = saveNameInput.value.trim();
    
    if (targetUid && customName) {
        socket.emit("save_contact", {
            myUid: my5DigitUid,
            targetUid: targetUid,
            customName: customName
        });
    }
});

socket.on("contact_saved", (contacts) => {
    searchUidInput.value = "";
    saveNameInput.value = "";
    myContacts = contacts;
    renderContacts(myContacts);
});

function renderContacts(contacts) {
    contactsList.innerHTML = "";
    if (!contacts) return;
    
    contacts.forEach(contact => {
        const unreadCount = unreadCounts[contact.uid] || 0;
        const unreadBadge = unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : "";

        const div = document.createElement("div");
        div.className = "contact-item";
        div.innerHTML = `
            <div class="avatar small">${contact.name.charAt(0).toUpperCase()}</div>
            <div class="chat-contact-info">
                <span class="name-text">${contact.name}</span>
            </div>
            ${unreadBadge}
        `;
        div.addEventListener("click", () => openChat(contact));
        contactsList.appendChild(div);
    });
}

function openChat(contact) {
    currentTargetUid = contact.uid;
    unreadCounts[contact.uid] = 0;
    renderContacts(myContacts);

    mainScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    document.getElementById("chat-contact-name").innerText = contact.name;
    document.getElementById("chat-avatar").innerText = contact.name.charAt(0).toUpperCase();
    
    socket.emit("join_chat", {
        myUid: my5DigitUid,
        targetUid: contact.uid
    });

    chatMessagesArea.innerHTML = "";
    if (chatHistory[contact.uid]) {
        chatHistory[contact.uid].forEach(msg => appendMessage(msg, msg.type));
    }
}

sendBtn.addEventListener("click", () => {
    const text = messageInput.value.trim();
    if (text && currentTargetUid) {
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

        messageInput.value = "";
    }
});

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
    const div = document.createElement("div");
    div.className = `msg-bubble ${type}`;
    div.innerHTML = `${data.text} <br><span style="font-size: 10px; color: gray; float: right; margin-top: 5px;">${data.timestamp}</span>`;
    chatMessagesArea.appendChild(div);
    chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
}

backBtn.addEventListener("click", () => {
    currentTargetUid = null;
    chatScreen.classList.add("hidden");
    mainScreen.classList.remove("hidden");
});
