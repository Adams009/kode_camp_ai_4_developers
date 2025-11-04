import { GoogleGenAI } from "@google/genai";
import envConfig from "./envConfig.js";


const genAI = new GoogleGenAI({
  apiKey: envConfig.geminiApiKey,
});

export default genAI