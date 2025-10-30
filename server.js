const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffprobeInstaller = require("@ffprobe-installer/ffprobe");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const say = require("say");
let TextToSpeechClient = null;
let googleTtsClient = null;

dotenv.config();

// ✅ Auto configure ffmpeg + ffprobe paths for all OS
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// __dirname is available in CommonJS by default
let useGoogleTts = process.env.USE_GOOGLE_TTS == "1";
// Also enable automatically if credentials are provided as env or path
const googleTtsCredsEnv = process.env.GOOGLE_TTS_CREDENTIALS; // path OR raw/base64 JSON
const googleTtsCredsPathEnv = process.env.GOOGLE_TTS_CREDENTIALS_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS; // file path
if (!useGoogleTts && (googleTtsCredsEnv || googleTtsCredsPathEnv)) {
    useGoogleTts = true;
}

if (useGoogleTts) {
    try {
        TextToSpeechClient = require("@google-cloud/text-to-speech").TextToSpeechClient;
        let clientOptions = undefined;
        if (googleTtsCredsPathEnv && fs.existsSync(googleTtsCredsPathEnv)) {
            // Use key file from provided path or GOOGLE_APPLICATION_CREDENTIALS
            clientOptions = { keyFilename: googleTtsCredsPathEnv };
        } else if (googleTtsCredsEnv) {
            // GOOGLE_TTS_CREDENTIALS may be a file path OR raw/base64 JSON
            if (fs.existsSync(googleTtsCredsEnv)) {
                clientOptions = { keyFilename: googleTtsCredsEnv };
            } else {
                // Support raw JSON or base64-encoded JSON in GOOGLE_TTS_CREDENTIALS
                let credsStr = googleTtsCredsEnv;
                try {
                    // If base64, decode
                    const maybeDecoded = Buffer.from(googleTtsCredsEnv, "base64").toString("utf8");
                    // Heuristic: base64 decode will produce a string; try JSON.parse to verify
                    JSON.parse(maybeDecoded);
                    credsStr = maybeDecoded;
                } catch (_) {
                    // Not base64 or not JSON; assume raw JSON string
                }
                const creds = JSON.parse(credsStr);
                // Normalize private_key newlines when provided via env vars (e.g. Render)
                const normalizedPrivateKey = creds.private_key && typeof creds.private_key === "string"
                    ? creds.private_key.replace(/\\n/g, "\n")
                    : creds.private_key;
                clientOptions = {
                    credentials: {
                        client_email: creds.client_email,
                        private_key: normalizedPrivateKey
                    },
                    projectId: creds.project_id
                };
            }
        }
        googleTtsClient = new TextToSpeechClient(clientOptions);
        console.log("🔊 Using Google Cloud Text-to-Speech");
    } catch (e) {
        console.warn("Google TTS not available, falling back to OS TTS:", e.message);
        useGoogleTts = false;
    }
}

const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "models/gemini-2.5-flash" });

// output directory for temporary audio files
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// helper: select OS voice name by gender
function getOsVoiceNameByGender(gender) {
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";
    if (isWin) {
        return gender === "male" ? "Microsoft David Desktop" : "Microsoft Zira Desktop";
    }
    if (isMac) {
        return gender === "male" ? "Alex" : "Samantha";
    }
    // Linux (espeak), try gender-specific variants
    return gender === "male" ? "en+m3" : "en+f3";
}

// 🔊 Convert text array to audio
async function convertScriptToAudio(script, genderMap) {
    const tempFiles = [];

    // 1️⃣ Generate individual clips
    for (let i = 0; i < script.length; i++) {
        const { speaker, text } = script[i];
        const gender = genderMap && genderMap[speaker] ? genderMap[speaker] : undefined;
        const tempPath = path.join(OUTPUT_DIR, `clip_${i}.mp3`);

        if (useGoogleTts && googleTtsClient) {
            const ssmlGender = gender === "male" ? "MALE" : gender === "female" ? "FEMALE" : "NEUTRAL";
            const request = {
                input: { text },
                voice: { languageCode: "en-US", ssmlGender },
                audioConfig: { audioEncoding: "MP3" }
            };
            const [response] = await googleTtsClient.synthesizeSpeech(request);
            const audioBuffer = Buffer.isBuffer(response.audioContent)
                ? response.audioContent
                : Buffer.from(response.audioContent, "base64");
            fs.writeFileSync(tempPath, audioBuffer);
            tempFiles.push(tempPath);
        } else {
            // Use OS-native TTS via say: export to wav then convert/merge to final mp3
            const wavPath = path.join(OUTPUT_DIR, `clip_${i}.wav`);
            const voiceName = getOsVoiceNameByGender(gender);
            await new Promise((resolve, reject) => {
                say.export(text, voiceName, 1.0, wavPath, (err) => {
                    if (err) return reject(err);
                    // Convert wav to mp3 for consistency
                    ffmpeg(wavPath)
                        .toFormat("mp3")
                        .on("end", () => {
                            try { fs.unlinkSync(wavPath); } catch { }
                            tempFiles.push(tempPath);
                            resolve();
                        })
                        .on("error", reject)
                        .save(tempPath);
                });
            });
        }
    }

    // 2️⃣ Merge clips into one final mp3
    const finalFile = path.join(OUTPUT_DIR, `podcast_${Date.now()}.mp3`);
    await new Promise((resolve, reject) => {
        const ff = ffmpeg();
        tempFiles.forEach((file) => ff.input(file));
        ff.mergeToFile(finalFile)
            .on("end", () => {
                // cleanup individual clips
                tempFiles.forEach(f => fs.unlinkSync(f));
                resolve();
            })
            .on("error", reject);
    });

    return finalFile;
}

// 🎙 Podcast generation route
app.post("/api/generate-podcast", async (req, res) => {
    try {
        const { topic, host, guestname, info, hostGender, guestGender } = req.body;

        if (!topic || !host) {
            return res.status(400).json({ error: "Please provide a topic and host name." });
        }

        const guests = Array.isArray(guestname) ? guestname : [];
        const guestList = guests.length ? guests.join(", ") : "No guests";
        const genderMap = {};
        if (host) genderMap[host] = hostGender;
        for (const g of guests) genderMap[g] = guestGender;
        const prompt = `
You are a professional podcast scriptwriter. Write a 15-minute podcast script on the topic: "${topic}".
Podcast details:
- Host: ${host}
- Guests: ${guestList.length ? guestList : "No guests"}
- Additional info: ${info || "No extra information provided"}
 
Instructions:
- Write in a natural, conversational style suitable for humans speaking aloud.
- Each line should be an object in an array with keys:
  { speaker: "SpeakerName", text: "Dialogue" }
- Format output ONLY as a JSON array of objects. Do NOT include any extra explanation or text outside the array.
- Each guest should have a distinct voice and speaking style.
- Include: engaging introduction, discussion points, short stories or examples, and conclusion with a call to action.
- Make it ready to use directly in your frontend for rendering or TTS conversion.
 - IMPORTANT: Use speaker names EXACTLY as provided for the host and guests: Host is "${host}" and guests are: ${guestList}. Do not invent new names.
`;

        const result = await model.generateContent(prompt);
        let script = await result.response.text();
        script = script.replace(/```(json)?/g, "").trim();

        try {
            script = JSON.parse(script);
        } catch (err) {
            console.error("JSON parse error:", err);
            return res.status(500).json({ error: "AI output invalid format." });
        }

        // 🗣 Generate audio
        const audioFile = await convertScriptToAudio(script, genderMap);
        const fileUrl = `/audio/${path.basename(audioFile)}`;

        res.json({ topic, host, guestname: guests, script, audio: fileUrl });
    } catch (error) {
        console.error("Error generating podcast:", error);
        res.status(500).json({ error: "Failed to generate podcast script or audio." });
    }
});

// serve generated audio files
app.use("/audio", express.static(OUTPUT_DIR));

// UI is served separately by Vite (port 3000) during development

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
