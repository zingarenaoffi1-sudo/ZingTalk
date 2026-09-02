import { socket, my5DigitUid, currentTargetUid } from './app.js';

const audioBtn = document.getElementById("audio-call-btn");
const videoBtn = document.getElementById("video-call-btn");
const endBtn = document.getElementById("end-call-btn");
const callScreen = document.getElementById("call-screen");
const localVideo = document.getElementById("local-video");
const remoteVideo = document.getElementById("remote-video");

let pc;
let localStream;
let remoteStream;

const rtcConfig = {
    iceServers: [
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" }
    ]
};

audioBtn.addEventListener("click", () => initCall(false));
videoBtn.addEventListener("click", () => initCall(true));
endBtn.addEventListener("click", endCall);

async function initCall(isVideo) {
    callScreen.classList.remove("hidden");
    localStream = await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
    localVideo.srcObject = localStream;
    
    pc = new RTCPeerConnection(rtcConfig);
    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;
    
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    
    pc.ontrack = event => {
        event.streams[0].getTracks().forEach(track => {
            remoteStream.addTrack(track);
        });
    };
    
    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit("webrtc_ice_candidate", {
                targetUid: currentTargetUid,
                candidate: event.candidate
            });
        }
    };
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc_offer", {
        targetUid: currentTargetUid,
        callerUid: my5DigitUid,
        offer: offer,
        isVideo: isVideo
    });
}

socket.on("webrtc_offer_received", async (data) => {
    callScreen.classList.remove("hidden");
    
    localStream = await navigator.mediaDevices.getUserMedia({ video: data.isVideo, audio: true });
    localVideo.srcObject = localStream;
    
    pc = new RTCPeerConnection(rtcConfig);
    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;
    
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    
    pc.ontrack = event => {
        event.streams[0].getTracks().forEach(track => {
            remoteStream.addTrack(track);
        });
    };
    
    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit("webrtc_ice_candidate", {
                targetUid: data.callerUid,
                candidate: event.candidate
            });
        }
    };
    
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socket.emit("webrtc_answer", {
        targetUid: data.callerUid,
        answer: answer
    });
});

socket.on("webrtc_answer_received", async (data) => {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
});

socket.on("webrtc_ice_candidate_received", async (data) => {
    if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
});

socket.on("webrtc_call_ended", () => {
    endCallLocally();
});

function endCall() {
    socket.emit("webrtc_end_call", { targetUid: currentTargetUid });
    endCallLocally();
}

function endCallLocally() {
    if (pc) {
        pc.close();
        pc = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    callScreen.classList.add("hidden");
    remoteVideo.srcObject = null;
    localVideo.srcObject = null;
}