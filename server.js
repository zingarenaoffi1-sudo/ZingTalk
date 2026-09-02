const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
});

const db = admin.firestore();
const connectedUsers = new Map();

io.on('connection', (socket) => {
    socket.on('login_user', async (data) => {
        let uid;
        const usersRef = db.collection('users');
        const snapshot = await usersRef.where('email', '==', data.email).get();

        if (snapshot.empty) {
            let isUnique = false;
            while (!isUnique) {
                uid = Math.floor(10000 + Math.random() * 90000).toString();
                const uidCheck = await usersRef.where('uid', '==', uid).get();
                if (uidCheck.empty) isUnique = true;
            }
            await usersRef.doc(uid).set({
                uid: uid,
                email: data.email,
                name: data.name,
                contacts: []
            });
        } else {
            const userData = snapshot.docs[0].data();
            uid = userData.uid;
        }

        connectedUsers.set(uid, socket.id);
        
        const userDoc = await usersRef.doc(uid).get();
        socket.emit('user_data', userDoc.data());

        socket.emit('receive_turn_config', {
            iceServers: [
                { urls: "stun:stun1.l.google.com:19302" },
                { urls: "stun:stun2.l.google.com:19302" }
            ]
        });
    });

    socket.on('save_contact', async (data) => {
        const userRef = db.collection('users').doc(data.myUid);
        const targetRef = db.collection('users').where('uid', '==', data.targetUid);
        const targetSnapshot = await targetRef.get();

        if (!targetSnapshot.empty) {
            const newContact = {
                uid: data.targetUid,
                name: data.customName
            };
            
            await db.runTransaction(async (t) => {
                const doc = await t.get(userRef);
                const currentContacts = doc.data().contacts || [];
                const updatedContacts = currentContacts.filter(c => c.uid !== data.targetUid);
                updatedContacts.push(newContact);
                t.update(userRef, { contacts: updatedContacts });
            });

            const updatedDoc = await userRef.get();
            socket.emit('contact_saved', updatedDoc.data().contacts);
        }
    });

    socket.on('join_chat', (data) => {
        const roomName = [data.myUid, data.targetUid].sort().join('_');
        socket.join(roomName);
    });

    socket.on('webrtc_offer', (data) => {
        const targetSocketId = connectedUsers.get(data.targetUid);
        if (targetSocketId) {
            io.to(targetSocketId).emit('webrtc_offer_received', data);
        }
    });

    socket.on('webrtc_answer', (data) => {
        const targetSocketId = connectedUsers.get(data.targetUid);
        if (targetSocketId) {
            io.to(targetSocketId).emit('webrtc_answer_received', data);
        }
    });

    socket.on('webrtc_ice_candidate', (data) => {
        const targetSocketId = connectedUsers.get(data.targetUid);
        if (targetSocketId) {
            io.to(targetSocketId).emit('webrtc_ice_candidate_received', data);
        }
    });

    socket.on('webrtc_end_call', (data) => {
        const targetSocketId = connectedUsers.get(data.targetUid);
        if (targetSocketId) {
            io.to(targetSocketId).emit('webrtc_call_ended');
        }
    });

    socket.on('disconnect', () => {
        for (const [uid, socketId] of connectedUsers.entries()) {
            if (socketId === socket.id) {
                connectedUsers.delete(uid);
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {});