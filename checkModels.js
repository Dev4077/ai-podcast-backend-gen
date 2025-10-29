import dotenv from "dotenv";
dotenv.config();

async function listModels() {
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1/models?key=${process.env.GOOGLE_API_KEY}`
        );
        const data = await response.json();

        if (data.models && Array.isArray(data.models)) {
            console.log("✅ Available models:");
            data.models.forEach((model) => console.log("• " + model.name));
        } else {
            console.error("❌ No models found or invalid key:", data);
        }
    } catch (error) {
        console.error("❌ Error fetching models:", error);
    }
}

listModels();
