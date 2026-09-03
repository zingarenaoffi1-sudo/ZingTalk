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

let currentUser = null;
export let my5DigitUid = null;
export let currentTargetUid = null;

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
    myName.innerText = currentUser.displayName;
    myUid.innerText = "UID: " + my5DigitUid;
    myAvatar.innerText = currentUser.displayName.charAt(0).toUpperCase();
    
    renderContacts(data.contacts);
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
    renderContacts(contacts);
});

function renderContacts(contacts) {
    contactsList.innerHTML = "";
    if (!contacts) return;
    
    contacts.forEach(contact => {
        const div = document.createElement("div");
        div.className = "contact-item";
        div.innerHTML = `
            <div class="avatar small">${contact.name.charAt(0).toUpperCase()}</div>
            <div class="chat-contact-info">
                <span class="name-text">${contact.name}</span>
            </div>
        `;
        div.addEventListener("click", () => openChat(contact));
        contactsList.appendChild(div);
    });
}

function openChat(contact) {
    currentTargetUid = contact.uid;
    mainScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    document.getElementById("chat-contact-name").innerText = contact.name;
    document.getElementById("chat-avatar").innerText = contact.name.charAt(0).toUpperCase();
    
    socket.emit("join_chat", {
        myUid: my5DigitUid,
        targetUid: contact.uid
    });
}

backBtn.addEventListener("click", () => {
    chatScreen.classList.add("hidden");
    mainScreen.classList.remove("hidden");
});
