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

dotenv.config();

// ✅ Configure ffmpeg + ffprobe
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

// Environment setup
let useGoogleTts = process.env.USE_GOOGLE_TTS === "1";
const googleTtsCredsEnv = process.env.GOOGLE_TTS_CREDENTIALS;
const googleTtsCredsPathEnv =
    process.env.GOOGLE_TTS_CREDENTIALS_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;

let TextToSpeechClient = null;
let googleTtsClient = null;

// ✅ Enable Google TTS if credentials exist
if (!useGoogleTts && (googleTtsCredsEnv || googleTtsCredsPathEnv)) {
    useGoogleTts = true;
}

if (useGoogleTts) {
    try {
        TextToSpeechClient = require("@google-cloud/text-to-speech").TextToSpeechClient;
        let clientOptions;

        if (googleTtsCredsPathEnv && fs.existsSync(googleTtsCredsPathEnv)) {
            console.log("🔊 Google TTS: using key file path");
            clientOptions = { keyFilename: googleTtsCredsPathEnv };
        } else if (googleTtsCredsEnv) {
            // Can be base64, path, or inline JSON
            let credsStr = googleTtsCredsEnv;

            if (fs.existsSync(googleTtsCredsEnv)) {
                console.log("🔊 Google TTS: using credentials file path");
                clientOptions = { keyFilename: googleTtsCredsEnv };
            } else {
                try {
                    // Try base64 decode
                    const maybeDecoded = Buffer.from(googleTtsCredsEnv, "base64").toString("utf8");
                    JSON.parse(maybeDecoded);
                    credsStr = maybeDecoded;
                } catch (_) {
                    // not base64 → assume raw JSON
                }

                const creds = JSON.parse(credsStr);
                let normalizedPrivateKey = creds.private_key;

                if (typeof normalizedPrivateKey === "string") {
                    normalizedPrivateKey = normalizedPrivateKey.replace(/\r/g, "");
                    normalizedPrivateKey = normalizedPrivateKey.replace(/\\n/g, "\n").trim();
                }

                clientOptions = {
                    credentials: {
                        client_email: creds.client_email,
                        private_key: normalizedPrivateKey,
                    },
                    projectId: creds.project_id,
                };
                console.log("🔊 Google TTS: using inline credentials");
            }
        }

        googleTtsClient = new TextToSpeechClient(clientOptions);
        console.log("✅ Google Cloud Text-to-Speech ready");
    } catch (err) {
        console.warn("⚠️ Google TTS unavailable, falling back to OS TTS:", err.message);
        useGoogleTts = false;
    }
}

const app = express();
app.use(cors());
app.use(express.json());

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "models/gemini-2.5-flash" });

// Output directory for audio files
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// OS voice selection by gender
function getOsVoiceNameByGender(gender) {
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";
    if (isWin) return gender === "male" ? "Microsoft David Desktop" : "Microsoft Zira Desktop";
    if (isMac) return gender === "male" ? "Alex" : "Samantha";
    return gender === "male" ? "en+m3" : "en+f3"; // Linux
}

// 🔉 Convert script to audio
async function convertScriptToAudio(script, genderMap) {
    const tempFiles = [];

    for (let i = 0; i < script.length; i++) {
        const { speaker, text } = script[i];
        const gender = genderMap?.[speaker];
        const tempPath = path.join(OUTPUT_DIR, `clip_${i}.mp3`);

        if (useGoogleTts && googleTtsClient) {
            const ssmlGender = gender === "male" ? "MALE" : gender === "female" ? "FEMALE" : "NEUTRAL";
            const request = {
                input: { text },
                voice: { languageCode: "en-US", ssmlGender },
                audioConfig: { audioEncoding: "MP3" },
            };

            const [response] = await googleTtsClient.synthesizeSpeech(request);
            const audioBuffer = Buffer.from(response.audioContent, "base64");
            fs.writeFileSync(tempPath, audioBuffer);
            tempFiles.push(tempPath);
        } else {
            const wavPath = path.join(OUTPUT_DIR, `clip_${i}.wav`);
            const voiceName = getOsVoiceNameByGender(gender);
            await new Promise((resolve, reject) => {
                say.export(text, voiceName, 1.0, wavPath, (err) => {
                    if (err) return reject(err);
                    ffmpeg(wavPath)
                        .toFormat("mp3")
                        .on("end", () => {
                            fs.unlinkSync(wavPath);
                            tempFiles.push(tempPath);
                            resolve();
                        })
                        .on("error", reject)
                        .save(tempPath);
                });
            });
        }
    }

    // Merge all clips
    const finalFile = path.join(OUTPUT_DIR, `podcast_${Date.now()}.mp3`);
    await new Promise((resolve, reject) => {
        const ff = ffmpeg();
        tempFiles.forEach((file) => ff.input(file));
        ff.mergeToFile(finalFile)
            .on("end", () => {
                tempFiles.forEach((f) => fs.unlinkSync(f));
                resolve();
            })
            .on("error", reject);
    });

    return finalFile;
}

// 🎙 Podcast route
app.post("/api/generate-podcast", async (req, res) => {
    try {
        const { topic, host, guestname, info, hostGender, guestGender } = req.body;
        if (!topic || !host) {
            return res.status(400).json({ error: "Please provide a topic and host name." });
        }

        const guests = Array.isArray(guestname) ? guestname : [];
        const genderMap = {};
        if (host) genderMap[host] = hostGender;
        for (const g of guests) genderMap[g] = guestGender;

        const prompt = `
You are a professional podcast scriptwriter. Write a 15-minute podcast script on the topic: "${topic}".
Podcast details:
- Host: ${host}
- Guests: ${guests.length ? guests.join(", ") : "No guests"}
- Info: ${info || "No extra info"}
Format as JSON array only: [{ "speaker": "Name", "text": "Dialogue" }]
`;

        const result = await model.generateContent(prompt);
        let script = result.response.text().replace(/```(json)?/g, "").trim();

        try {
            script = JSON.parse(script);
        } catch (err) {
            console.error("❌ JSON parse error:", err);
            return res.status(500).json({ error: "AI output invalid format" });
        }

        const audioFile = await convertScriptToAudio(script, genderMap);
        const fileUrl = `/audio/${path.basename(audioFile)}`;

        res.json({ topic, host, guestname: guests, script, audio: fileUrl });
    } catch (error) {
        console.error("Error generating podcast:", error);
        res.status(500).json({ error: "Failed to generate podcast script or audio." });
    }
});

// Serve generated audio
app.use("/audio", express.static(OUTPUT_DIR));

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
