import dotenv from "dotenv";
dotenv.config();

const envConfig = {
    port: Number(process.env.PORT),
    geminiApiKey: String(process.env.GEMINI_API_KEY),
}

export default envConfig;