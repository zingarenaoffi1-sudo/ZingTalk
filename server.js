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

const defaultProjectId = "zing-talk-c6496";
const defaultClientEmail = "firebase-adminsdk-fbsvc@zing-talkc6496.iam.gserviceaccount.com";
const defaultPrivateKey = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCuymPxf21ZEf7V\nli8N80rVTv5n5/GNeLB0CHv7BXJLamNzNIUg1GTPLNVSh6h9y2fJN9Jp+SpMKfAi\njJn3bkVV8fBvS5zKj7U9G2U9DhajX0JCLFEnKoo9ydO7JwT18WzG25GAvD6grGKC\nf7Ud/OQgqvmmQ0WqIRGGeZT5YKqurEcB3iseqpimg6tqLoYRqHoaUnOAlfqVVjWx\nfVHZSeM0AdYaQCAYCmiGF2xwRTuUl7aeqK6iQqkaf4QMBbdt3QoypwbOTqQJV/1x\nhKfsNBCdF6TsNiFzZFzJMQWUsIQVRY7Klcy/MYQDDDIMP89v/Zj8UG0CvO8HBuYc\nxyXOzaWdAgMBAAECggEAIPsTbKgMq/fXS9nwuwMjJaioHFcJnxYcxWgsbKsUa+KB\nLWXFkPJCq0zcW5w5ULMmvDMKQvC+6GwpYXuCOcvWzWa/ZWCxDw+atRMMQT79SopY\n6D+QeIFwYERK7U9pgjaxvbwEcnQSpSKh29nZBPWI3hkkzhh3dqiSs/sQ/xUcX6TW\nJu0C4d3FjMwOB7tq8Aai2NNBm0OCi2VefgR8j8n3VtZVbtB4ePoFNybfdYiUqXaa\njkn6/mlwKZ4AFPIIzvPKp9RVcgXMVhPWXbfsx4a9/aNrM/LvKHOIbCGKEFWf+ykP\nlw5tT/806l5//A2Nndwhwaj4I5ZnFHDbfJ0pGV2SiQKBgQDiOpKojATLipZDnYX7\nfkzHSnTpNp71yioUhHUaTFbI8P4niC2JV1wORQCX6KNtYolysytE2dbDBGH0AiJs\nOB0UevmKvhWH7CPNUKNDbLkzYlXgb67j2qOY1lu5lQ/vLP1L2xs0XqwDLdf/Gy43\n3Jpgvo1WxRk5xjx6UmnFw5GBlwKBgQDFyuoXPGPQyEIkW2OMc0dvFiAmaX3VaKym\nQrUbg7SkaOfaWiNUrv3NdPdkW74+7/LwOWadUpPCQA3gd3tAQkhkxTzW+pWj1qXq\nShI9Il9hy/jxAjft6DFTDBcf/SZEpoLqSZLEdp7S0jwkJih0MAYHDsuJlJOL9Luu\nyvjvdLfQ6wKBgE87ZmwDhhZndlM+E1POm0NdL28Sgz/gSzaeYYkRXX/I76qWxiQI\n5aPVxOxvPPWtgiga2jel99KbcVcNfFLcoEqw+z79bfsJ2EwrRtLxfDej5CHT27PP\numZoBP4NV+RTpG7x0ShZU/NVFgYx1dEYwTTK6COQqlISvNG2lXb/FLIHAoGAIvnX\n3VYDfJb9AzrZ5qs39Y/fDYvYAZXp+diP+BaZKf2XCkioOMBdByjo2mlSwgRiXFJ6\nL9W7ZT04dvoJ5HoUHSW3tXhIX9mEK2L/yKm8XinYkp3G0B4gIsRfjnuQedFMEywB\ndRZYzYT5t5a7zpfzaOoX2fNZCAW17pnb3VQxcRMCgYEAgRA43Y+awdPk65Nycvpo\nby8NYPs1PYef8O+ebHED6bqfT+M0AiOzb1BHU/ZtYnjJ5b76t48HcN276z/fTj6z\n8XvrG0F8epcvSWzYmsEgcoWeyJTytWXr1ai6sBFQ3IxxgVVL8RTgVSCFX1wrqMlM\nsM1nbrLc3w+Qg3xcexF9tGk=\n-----END PRIVATE KEY-----\n`;

const fbProjectId = process.env.FIREBASE_PROJECT_ID || defaultProjectId;
const fbClientEmail = process.env.FIREBASE_CLIENT_EMAIL || defaultClientEmail;
const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY || defaultPrivateKey;
const fbPrivateKey = rawPrivateKey.replace(/\\n/g, '\n');

let db;
try {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: fbProjectId,
            clientEmail: fbClientEmail,
            privateKey: fbPrivateKey
        })
    });
    db = admin.firestore();
    console.log('[ZingTalk] Initialized Firebase Admin Firestore successfully for project:', fbProjectId);
} catch (err) {
    console.warn('[ZingTalk] Firebase Admin initialization note:', err.message);
    db = createMemoryDb();
}

// Generate unique 10-digit UID
function generate10DigitUid() {
    return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

const connectedUsers = new Map();

// In-Memory Groups Registry (Zero disk/Firebase storage load)
const inMemoryGroups = new Map();

io.on('connection', (socket) => {
    socket.on('login_user', async (data) => {
        try {
            let uid;
            const usersRef = db.collection('users');
            const snapshot = await usersRef.where('email', '==', data.email).get();

            if (snapshot.empty) {
                let isUnique = false;
                while (!isUnique) {
                    uid = generate10DigitUid();
                    const uidCheck = await usersRef.where('uid', '==', uid).get();
                    if (uidCheck.empty) isUnique = true;
                }
                const newUser = {
                    uid: uid,
                    email: data.email,
                    name: data.name || "User",
                    contacts: []
                };
                await usersRef.doc(uid).set(newUser);
            } else {
                uid = snapshot.docs[0].data().uid;
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

    socket.on('save_contact', async (data) => {
        try {
            const userRef = db.collection('users').doc(data.myUid);
            const targetRef = db.collection('users').where('uid', '==', data.targetUid);
            const targetSnapshot = await targetRef.get();

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
        io.to(data.receiverUid).emit('receive_message', data);
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
