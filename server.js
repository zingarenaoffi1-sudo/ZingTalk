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
    },
    maxHttpBufferSize: 5e7 // 50MB for zero-server media file sharing
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

const memoryDb = createMemoryDb();
let db = memoryDb;

if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    try {
        const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
        const fbPrivateKey = rawPrivateKey.replace(/\\n/g, '\n');
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: fbPrivateKey
            })
        });
        db = admin.firestore();
        console.log('[ZingTalk] Initialized Firebase Admin Firestore successfully for project:', process.env.FIREBASE_PROJECT_ID);
    } catch (err) {
        console.warn('[ZingTalk] Firebase Admin initialization note:', err.message);
        db = memoryDb;
    }
} else {
    console.log('[ZingTalk] Initialized in-memory database store (zero cloud configuration required).');
}

// Pre-seed a support contact in memory for instant contact testing
inMemoryUsers.set("1000000001", {
    uid: "1000000001",
    name: "ZingTalk Support",
    email: "support@zingtalk.local",
    contacts: []
});

// Generate unique 10-digit UID
function generate10DigitUid() {
    return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

const connectedUsers = new Map();

// In-Memory Groups Registry (Zero disk/Firebase storage load)
const inMemoryGroups = new Map();

// WhatsApp-style In-Memory Block Registry (blockerUid -> Set of blockedUids)
const inMemoryBlocks = new Map();

io.on('connection', (socket) => {
    socket.on('login_user', async (data) => {
        try {
            let uid;
            let usersRef = db.collection('users');
            let snapshot;
            try {
                snapshot = await usersRef.where('email', '==', data.email).get();
            } catch (fsErr) {
                console.warn('[ZingTalk] Database query failed, falling back to memory store:', fsErr.message);
                db = memoryDb;
                usersRef = db.collection('users');
                snapshot = await usersRef.where('email', '==', data.email).get();
            }

            const existingDoc = !snapshot.empty ? snapshot.docs[0].data() : null;
            const existingUid = existingDoc ? String(existingDoc.uid || "") : "";

            // Strict enforcement: UID MUST be exactly 10 digits
            if (snapshot.empty || !existingUid || existingUid.length !== 10) {
                let isUnique = false;
                while (!isUnique) {
                    uid = generate10DigitUid();
                    const uidCheck = await usersRef.where('uid', '==', uid).get();
                    if (uidCheck.empty) isUnique = true;
                }
                const newUser = {
                    ...(existingDoc || {}),
                    uid: uid,
                    email: data.email,
                    name: data.name || (existingDoc && existingDoc.name) || "User",
                    contacts: (existingDoc && existingDoc.contacts) || []
                };
                await usersRef.doc(uid).set(newUser);
            } else {
                uid = existingUid;
            }

            connectedUsers.set(uid, socket.id);
            socket.join(uid);

            // Auto-join existing in-memory group rooms
            for (const [groupId, group] of inMemoryGroups.entries()) {
                if (group.members && group.members.includes(uid)) {
                    socket.join(groupId);
                }
            }
            
            const userDoc = await usersRef.doc(uid).get();
            socket.emit('user_data', userDoc.data());
        } catch (err) {
            console.error('[ZingTalk] Error in login_user:', err);
        }
    });

    // WhatsApp-Style Block / Unblock Handlers
    socket.on('block_user', (data) => {
        if (!data.blockerUid || !data.blockedUid) return;
        if (!inMemoryBlocks.has(data.blockerUid)) {
            inMemoryBlocks.set(data.blockerUid, new Set());
        }
        inMemoryBlocks.get(data.blockerUid).add(data.blockedUid);
        console.log(`[ZingTalk Block] ${data.blockerUid} blocked ${data.blockedUid}`);
    });

    socket.on('unblock_user', (data) => {
        if (!data.blockerUid || !data.blockedUid) return;
        if (inMemoryBlocks.has(data.blockerUid)) {
            inMemoryBlocks.get(data.blockerUid).delete(data.blockedUid);
        }
        console.log(`[ZingTalk Block] ${data.blockerUid} unblocked ${data.blockedUid}`);
    });

    socket.on('save_contact', async (data) => {
        try {
            let userRef = db.collection('users').doc(data.myUid);
            let targetRef = db.collection('users').where('uid', '==', data.targetUid);
            let targetSnapshot;
            try {
                targetSnapshot = await targetRef.get();
            } catch (fsErr) {
                console.warn('[ZingTalk] Database query failed in save_contact, falling back to memory store:', fsErr.message);
                db = memoryDb;
                userRef = db.collection('users').doc(data.myUid);
                targetRef = db.collection('users').where('uid', '==', data.targetUid);
                targetSnapshot = await targetRef.get();
            }

            if (!targetSnapshot.empty) {
                const newContact = { uid: data.targetUid, name: data.customName };
                await db.runTransaction(async (t) => {
                    const doc = await t.get(userRef);
                    const currentContacts = (doc.data() && doc.data().contacts) || [];
                    const updatedContacts = currentContacts.filter(c => c.uid !== data.targetUid);
                    updatedContacts.push(newContact);
                    t.update(userRef, { contacts: updatedContacts });
                });
                const updatedDoc = await userRef.get();
                socket.emit('contact_saved', updatedDoc.data().contacts);
            } else {
                socket.emit('contact_error', 'User with 10-digit UID ' + data.targetUid + ' not found.');
            }
        } catch (err) {
            console.error('[ZingTalk] Error in save_contact:', err);
            socket.emit('contact_error', 'Failed to save contact.');
        }
    });

    socket.on('send_message', (data) => {
        // WhatsApp Block Logic: If receiver has blocked sender, do NOT deliver
        const receiverBlockedList = inMemoryBlocks.get(data.receiverUid);
        if (receiverBlockedList && receiverBlockedList.has(data.senderUid)) {
            // Emulate WhatsApp single checkmark (sent from phone, blocked by receiver)
            socket.emit('message_status', { msgId: data.id, delivered: false });
            return;
        }
        io.to(data.receiverUid).emit('receive_message', data);
        socket.emit('message_status', { msgId: data.id, delivered: true });
    });

    // Group Management (Zero disk/Firebase load)
    socket.on('create_group', (data) => {
        try {
            const groupId = Math.floor(1000000000 + Math.random() * 9000000000).toString();
            const newGroup = {
                groupId,
                name: data.name || "ZingTalk Group",
                icon: data.icon || "👥",
                creatorUid: data.creatorUid,
                members: Array.from(new Set([data.creatorUid, ...(data.members || [])])),
                createdAt: Date.now()
            };
            inMemoryGroups.set(groupId, newGroup);
            socket.join(groupId);

            // Join connected members to group room
            newGroup.members.forEach(memberUid => {
                const targetSocketId = connectedUsers.get(memberUid);
                if (targetSocketId) {
                    const targetSocket = io.sockets.sockets.get(targetSocketId);
                    if (targetSocket) targetSocket.join(groupId);
                    io.to(memberUid).emit('group_added', newGroup);
                }
            });

            socket.emit('group_created', newGroup);
        } catch (err) {
            console.error('[ZingTalk] Error in create_group:', err);
        }
    });

    socket.on('join_group_room', (groupId) => {
        socket.join(groupId);
    });

    socket.on('send_group_message', (data) => {
        // Zero-storage broadcast to group members
        io.to(data.groupId).emit('receive_group_message', data);
    });

    // Real-Time WhatsApp-style Typing Indicator
    socket.on('typing', (data) => {
        if (data.isGroup) {
            socket.to(data.targetId).emit('user_typing', data);
        } else {
            const targetBlockedList = inMemoryBlocks.get(data.targetId);
            if (targetBlockedList && targetBlockedList.has(data.senderUid)) {
                return; // Suppress typing indicator if target blocked sender
            }
            io.to(data.targetId).emit('user_typing', data);
        }
    });

    socket.on('stop_typing', (data) => {
        if (data.isGroup) {
            socket.to(data.targetId).emit('user_stop_typing', data);
        } else {
            io.to(data.targetId).emit('user_stop_typing', data);
        }
    });

    // WhatsApp-style Emoji Reactions
    socket.on('send_reaction', (data) => {
        if (data.isGroup) {
            io.to(data.targetId).emit('receive_reaction', data);
        } else {
            io.to(data.targetId).emit('receive_reaction', data);
        }
    });

    // Abuse / Inappropriate Content Reporting
    socket.on('report_content', (data) => {
        console.log(`[ZingTalk Compliance] Flagged report received from ${data.reporterUid} against target ${data.targetId}. Reason: ${data.reason}`);
        socket.emit('report_ack', { status: 'success', message: 'Report submitted. Our moderation team has logged this incident.' });
    });

    socket.on('initiate_call', (data) => {
        // WhatsApp Block Logic: If target has blocked caller, decline immediately without ringing
        const targetBlockedList = inMemoryBlocks.get(data.targetUid);
        if (targetBlockedList && targetBlockedList.has(data.callerUid)) {
            socket.emit('call_response_received', { targetUid: data.targetUid, status: 'declined', reason: 'blocked' });
            return;
        }
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
