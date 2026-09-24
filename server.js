const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static frontend assets
app.use(express.static(__dirname));

// In-Memory Database Fallback for users and contacts
const inMemoryUsers = new Map();

function createMemoryDb() {
    return {
        collection: (colName) => ({
            where: (field, op, val) => ({
                get: async () => {
                    const docs = [];
                    for (const [id, user] of inMemoryUsers.entries()) {
                        if (op === '==' && user[field] === val) {
                            docs.push({
                                id,
                                data: () => ({ ...user })
                            });
                        }
                    }
                    return {
                        empty: docs.length === 0,
                        docs
                    };
                }
            }),
            doc: (id) => ({
                _id: id,
                get: async () => {
                    const user = inMemoryUsers.get(id);
                    return {
                        exists: !!user,
                        data: () => user ? ({ ...user }) : null
                    };
                },
                set: async (data) => {
                    inMemoryUsers.set(id, { ...data });
                },
                update: async (data) => {
                    const current = inMemoryUsers.get(id) || {};
                    inMemoryUsers.set(id, { ...current, ...data });
                }
            })
        }),
        runTransaction: async (updateFunction) => {
            const transaction = {
                get: async (ref) => ref.get(),
                update: async (ref, data) => {
                    if (ref.update) {
                        await ref.update(data);
                    } else if (ref._id) {
                        const current = inMemoryUsers.get(ref._id) || {};
                        inMemoryUsers.set(ref._id, { ...current, ...data });
                    }
                }
            };
            return await updateFunction(transaction);
        }
    };
}

let db;
try {
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            })
        });
        db = admin.firestore();
        console.log('[ZingTalk] Connected to Firebase Firestore successfully.');
    } else {
        console.warn('[ZingTalk] Firebase Admin credentials not provided. Using in-memory store.');
        db = createMemoryDb();
    }
} catch (err) {
    console.warn('[ZingTalk] Failed to initialize Firebase Admin, using in-memory store:', err.message);
    db = createMemoryDb();
}

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
            await usersRef.doc(uid).set({ uid: uid, email: data.email, name: data.name, contacts: [] });
        } else {
            uid = snapshot.docs[0].data().uid;
        }

        connectedUsers.set(uid, socket.id);
        socket.join(uid);
        
        const userDoc = await usersRef.doc(uid).get();
        socket.emit('user_data', userDoc.data());
    });

    socket.on('save_contact', async (data) => {
        const userRef = db.collection('users').doc(data.myUid);
        const targetRef = db.collection('users').where('uid', '==', data.targetUid);
        const targetSnapshot = await targetRef.get();

        if (!targetSnapshot.empty) {
            const newContact = { uid: data.targetUid, name: data.customName };
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

    socket.on('send_message', (data) => {
        io.to(data.receiverUid).emit('receive_message', data);
    });

    socket.on('initiate_call', (data) => {
        io.to(data.targetUid).emit('incoming_call', data);
    });

    socket.on('cancel_call', (data) => {
        io.to(data.targetUid).emit('call_cancelled');
    });

    socket.on('call_response', (data) => {
        io.to(data.targetUid).emit('call_response_received', data);
    });

    socket.on('webrtc_offer', (data) => {
        io.to(data.targetUid).emit('webrtc_offer_received', data);
    });

    socket.on('webrtc_answer', (data) => {
        io.to(data.targetUid).emit('webrtc_answer_received', data);
    });

    socket.on('webrtc_ice_candidate', (data) => {
        io.to(data.targetUid).emit('webrtc_ice_candidate_received', data);
    });

    socket.on('webrtc_end_call', (data) => {
        io.to(data.targetUid).emit('webrtc_call_ended');
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

// SPA fallback
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[ZingTalk] Server running on http://0.0.0.0:${PORT}`);
});
