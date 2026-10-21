const roomId = "front_page";
const peers = new Map(); // peerId -> { pc, dc }
const peersPublicKeys = new Map(); // peerId -> publicKey

let clientId;
let privateKey;
let publicKey;
let ws;

window.addEventListener("DOMContentLoaded", async () => {
  const keyData = await retrieveKeys();
  privateKey = keyData.privateKey;

  publicKey = await exportPublicKey(keyData.publicKey);

  clientId = keyData.clientId;

  ws = new WebSocket(`ws://localhost:8001/ws/webrtc/${roomId}/${clientId}`);

  ws.onopen = () => {
    console.log("[WS] Connected to signaling server");
    sendSignaling(null, "new_peer", "");
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    await handleSignalingMessage(msg);
  };
});

// ---------------------
// DataChannel helpers
// ---------------------
function setupDataChannel(dc, peerId) {
  dc.onopen = () => {
    console.log(`[CONNECTED] DataChannel open with ${peerId}`);
    exchangeKeys(peerId);
  };
  dc.onclose = () =>
    console.log(`[DISCONNECTED] DataChannel closed with ${peerId}`);
  dc.onmessage = (event) =>
    handleMessage(event).catch((e) =>
      console.error(`[ERROR] Handling message from ${peerId}:`, e)
    );
}

async function handleMessage(event) {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case "key_exchange":
      peersPublicKeys.set(
        msg.data.clientId,
        await importPublicKey(msg.data.publicKey)
      );
      console.log(
        `[KEY_EXCHANGE] Received public key from ${msg.data.clientId}`
      );
      break;
    case "message":
      const messageContent = msg.data.content;
      const decryptedContent = await decryptData(messageContent);
      console.log(`[MESSAGE] From ${msg.data.clientId}: ${decryptedContent}`);
      break;
    // Handle other message types...
  }
}

async function exchangeKeys(peerId) {
  const peer = peers.get(peerId);
  if (peer?.dc?.readyState === "open") {
    const keyData = {
      publicKey,
      clientId,
    };
    peer.dc.send(JSON.stringify({ type: "key_exchange", data: keyData }));
  }
}

function sendToPeer(peerId, message) {
  const peer = peers.get(peerId);
  if (peer?.dc?.readyState === "open") {
    peer.dc.send(message);
    console.log(`[SENT] To ${peerId}: ${message}`);
  }
}

async function broadcastMessage(message) {
  for (const [peerId, { dc }] of peers.entries()) {
    if (message.type === "message" && dc?.readyState === "open") {
      const encryptedMessage = await encryptData(
        peersPublicKeys.get(peerId),
        message.content
      );

      dc.send(
        JSON.stringify({
          type: "message",
          data: { content: arrayBufferToBase64(encryptedMessage), clientId },
        })
      );
    }
  }
}

// ---------------------
// Signaling helpers
// ---------------------
function sendSignaling(to, msgType, data) {
  ws.send(
    JSON.stringify({ from: clientId, to: to || null, msg_type: msgType, data })
  );
  console.log(`[SIGNAL] Sent ${msgType} to ${to || "all peers"}`);
}

// ---------------------
// PeerConnection
// ---------------------
async function createPeerConnection(peerId, isInitiator) {
  if (peers.has(peerId)) return peers.get(peerId).pc;

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.tuxprint.com:3478" },
      {
        urls: "turn:stun.tuxprint.com:3478",
        username: "tds_user",
        credential: "tds_pass",
      },
    ],
  });

  let dc;

  if (isInitiator) {
    dc = pc.createDataChannel("messaging");
    setupDataChannel(dc, peerId);
  } else {
    pc.ondatachannel = (event) => {
      dc = event.channel;
      setupDataChannel(dc, peerId);
      const peer = peers.get(peerId) || {};
      peer.dc = dc;
      peers.set(peerId, peer);
    };
  }

  pc.onicecandidate = (event) => {
    if (event.candidate)
      sendSignaling(peerId, "candidate", JSON.stringify(event.candidate));
  };

  pc.onconnectionstatechange = () => {
    console.log(`[STATE] Connection with ${peerId}: ${pc.connectionState}`);
  };

  peers.set(peerId, { pc, dc });
  return pc;
}

// ---------------------
// Handle signaling messages
// ---------------------
async function handleSignalingMessage(msg) {
  const { from, msg_type, data, to } = msg;
  if (from === clientId) return;
  if (to && to !== clientId) return;

  let isInitiator = msg_type === "new_peer";
  const pc = await createPeerConnection(from, isInitiator);

  switch (msg_type) {
    case "peer_left":
      console.log(`[INFO] Peer left: ${from}`);
      pc.close();
      peers.delete(from);
      peersPublicKeys.delete(from);
      break;
    case "new_peer":
      console.log(`[INFO] New peer joined: ${from}, sending offer`);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignaling(from, "offer", offer.sdp);
      break;

    case "offer":
      console.log(`[SIGNAL] Received offer from ${from}`);
      await pc.setRemoteDescription({ type: "offer", sdp: data });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignaling(from, "answer", answer.sdp);
      break;

    case "answer":
      console.log(`[SIGNAL] Received answer from ${from}`);
      await pc.setRemoteDescription({ type: "answer", sdp: data });
      break;

    case "candidate":
      await pc.addIceCandidate(JSON.parse(data));
      break;
  }
}

// ---------------------
// API
// ---------------------
function sendRoomMessage(msg) {
  broadcastMessage(msg);
}

function sendPrivateMessage(peerId, msg) {
  sendToPeer(peerId, msg);
}

async function generateKeys() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048, // can be 2048 or 4096
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: "SHA-256",
    },
    true, // extractable
    ["encrypt", "decrypt"]
  );
  return keyPair;
}

async function encryptData(publicKey, message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "RSA-OAEP",
    },
    publicKey,
    data
  );
  return encrypted;
}

async function decryptData(encryptedData) {
  console.log("Decrypting data:", encryptedData);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "RSA-OAEP",
    },
    privateKey,
    base64ToArrayBuffer(encryptedData)
  );
  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

async function retrieveKeys() {
  let storedPublic = sessionStorage.getItem("publicKey");
  let storedPrivate = sessionStorage.getItem("privateKey");
  const clientId = sessionStorage.getItem("clientId") || crypto.randomUUID();

  if (!storedPublic || !storedPrivate || !clientId) {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"]
    );

    sessionStorage.setItem(
      "publicKey",
      await exportPublicKey(keyPair.publicKey)
    );
    sessionStorage.setItem(
      "privateKey",
      await exportPrivateKey(keyPair.privateKey)
    );

    sessionStorage.setItem("clientId", clientId);

    return {
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      clientId,
    };
  }

  const publicKey = await importPublicKey(storedPublic);
  const privateKey = await importPrivateKey(storedPrivate);

  return { publicKey, privateKey, clientId };
}

async function exportPublicKey(key) {
  const spki = await crypto.subtle.exportKey("spki", key);
  return arrayBufferToBase64(spki);
}

async function exportPrivateKey(key) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key);
  return arrayBufferToBase64(pkcs8);
}

async function importPublicKey(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    "spki",
    bytes.buffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"]
  );
}

async function importPrivateKey(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
