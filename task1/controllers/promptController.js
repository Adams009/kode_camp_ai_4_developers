import genAI from "../configs/geminiClientConfig.js"
import { isInputUnsafe, moderateOutput } from "../utils/moderator.js";
const getPromptResponse = async (req, res) => {
    const { userPrompt, systemPrompt } = req.body;

    if (!userPrompt || userPrompt.trim() === "" || typeof userPrompt !== "string") {
        return res.status(400).json({ message: "Invalid prompt" });
    }

    if (typeof systemPrompt !== "string") {
        return res.status(400).json({ message: "Invalid system prompt" });
    }

    const sanitizedUserPrompt = userPrompt.trim();
    const sanitizedSystemPrompt = systemPrompt ? systemPrompt.trim() : "You are a helpful and polite assistant.";

    if (isInputUnsafe(sanitizedUserPrompt) || isInputUnsafe(sanitizedSystemPrompt)) {
        return res.status(400).json({
            error: "Your input violated the moderation policy. Please rephrase.",
        });
    }


    try {
        const completion = await genAI.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [
                {
                    role: "user", 
                    parts: [
                        { text: `${sanitizedSystemPrompt}\n\nUser: ${sanitizedUserPrompt}` },
                    ],
                },
            ],
        });

        let aiResponse = completion.candidates[0].content.parts[0].text; 

        aiResponse = moderateOutput(aiResponse);

        if (aiResponse.includes("[REDACTED]")) {
            return res.json({
                warning: "Some unsafe words were removed for moderation.",
                response: aiResponse,
            });
        }

        res.status(200).json({ response: aiResponse });
    } catch (error) {
        console.error("Gemini API error:", error);
        res.status(500).json({ message: "Error generating response" });
    }
};

export default getPromptResponse;
