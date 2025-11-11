import dotenv from "dotenv";
dotenv.config();
import { GoogleGenAI } from "@google/genai";


const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const categories = [
    "Account Opening",
    "Billing Issue",
    "Account Access",
    "Transaction Inquiry",
    "Card Services",
    "Account Statement",
    "Loan Inquiry",
    "General Information"
]

function markDownRemover(text) {
  // Extract the JSON inside ```json ... ```
  const match = text.match(/```json([\s\S]*?)```/);
  
  if (match && match[1]) {
    return match[1].trim(); // return only the inner JSON
  }

  // Fallback: remove Markdown fences if they exist, else return original
  return text
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();
}

function intentInterpterPrompt(customerQuery) {
    return `
    You are a bank assistant chatbox that reads and analyzes a customer message or report.\n
    Analyze the following customer message and describe in one sentence what the customer wants or reports.\n
    Also list the most important keywords/phrases from the message that support or describe customer wants or reports.\n
    Customer Message:\n
    \`\`\`\n
    ${customerQuery}\n
    \`\`\`
 `
}

function categoryMapperPrompt(analysedReport, categories) {
    return `
    Based on the analysed and described customer report with the list of important keywords/phrases\n
    \`\`\`\n
    ${analysedReport}\n
    \`\`\`\n
    Suggest and map up to three relevant categories from the following list that could be apply to the report:\n
    \`\`\`\n
    ${categories.join("\n- ")}\n
    \`\`\`\n
    In your Output, let it be a json in a list. for each category include a confidence score between 0 and 1 and a one-line reason that ties the category in this json format "category": , "score": , "reason":.
    `
}

function appropriateCategoryPrompt(analysedReport, categoryList) {
    categoryList = markDownRemover(categoryList);
    const sanitisedCategoryList = JSON.parse(categoryList)

    return `
    From the suggested categories with confidence scores:\n
    \`\`\`\n
    ${sanitisedCategoryList.map(category => `${category.category}: ${category.score} - ${category.reason}`).join("\n")}\n
    \`\`\`\n
    choose the single best category and explain in 1-2 sentences why it is best (cite the strongest evidence words) with this analysed word below.\n
    \`\`\`\n
    ${analysedReport}\n
    \`\`\`\n
    Let your output be in this json format "chosenCategory":"", "score":, "explanation":"".
    `
}

function MoreDetailsExtractorPrompt(chosenCategory, customerQuery) {
    chosenCategory = markDownRemover(chosenCategory);
    const santisedCategory = JSON.parse(chosenCategory)

    return `
    For the chosen category\n
    \`\`\`\n
     ${santisedCategory.chosenCategory}: ${santisedCategory.score} - ${santisedCategory.explanation}\n
    \`\`\`\n
    extract any additional details that would be needed from the original customer message and are relevant to resolving the issue.\n
    These may include transaction date, amount, card type, account number, or other specifics.\n
    If there are no additional details needed in the customer message, list "missing" details you deem necessary but missing.\n
    Customer Message:\n
    \`\`\`\n
    ${customerQuery}\n
    \`\`\`\n

    Let your output be in this json format "extractedDetails":{key:value}, "missingDetails":[list].
    `
}

function responsePrompt(chosenCategory, additionalDetails, analysedReport, customerQuery) {
    chosenCategory = markDownRemover(chosenCategory);
    const santisedCategory = JSON.parse(chosenCategory)
    additionalDetails = markDownRemover(additionalDetails)
    const santisedAdditionalDetails = JSON.parse(additionalDetails)

    return `
    You are the banking assistant\n
    Using the chosen category\n
    \`\`\`\n
    ${santisedCategory.chosenCategory}: ${santisedCategory.score} - ${santisedCategory.explanation}\n
    \`\`\`\n
    and the additional extracted details:\n
    \`\`\`\n
    ${Object.entries(santisedAdditionalDetails.extractedDetails).map(([key, value]) => `${key}: ${value}`).join("\n")}\n
    ${santisedAdditionalDetails.missingDetails.length > 0 ? `Missing Details:\n ${santisedAdditionalDetails.missingDetails.join("\n- ")}` : "No missing details."}\n
    \`\`\`\n
    Generate a concise, polite, and helpful response (≤ 50 words) to the customer analysed report:\n
    \`\`\`\n
    ${analysedReport}\n
    \`\`\`\n
    extracted from a customer query:\n
    \`\`\`\n
    ${customerQuery}\n
    \`\`\`\n
    that acknowledges their issue and outlines the next steps or resolution.\n
    If any needed detail appeared in the "missing" list of additonal extracted details:\n
     \`\`\`\n
    ${Object.entries(santisedAdditionalDetails.extractedDetails).map(([key, value]) => `${key}: ${value}`).join("\n")}\n
    ${santisedAdditionalDetails.missingDetails.length > 0 ? `Missing Details:\n ${santisedAdditionalDetails.missingDetails.join("\n- ")}` : "No missing details."}\n
    \`\`\`\n
    include one polite question asking for the most critical missing item first.
    `
}


const aiPrompter = async (query) => {

    if (!query || query.trim() === "" || typeof query !== "string") {
        return { message: "Invalid prompt" };
    }

    const sanitizedQuery = query.trim();
    const systemPrompt = "You are a helpful, polite and intelligent customer bank support assistant.";

    try {
        const completion = await genAI.models.generateContent({
            model: "gemini-2.0-flash",
            contents: [
                {
                    role: "user", 
                    parts: [
                        { text: `${systemPrompt}\n\nUser: ${sanitizedQuery}` },
                    ],
                },
            ],
        });

        const aiResponse = completion.candidates[0].content.parts[0].text;
        return aiResponse;
    } catch (error) {
        return { message: "Error generating response" };    
    }
};

async function runPromptChain(customerQuery) {
    const response = []
    const analysedReport = await aiPrompter(intentInterpterPrompt(customerQuery));
    response.push(analysedReport)
    const categoryList = await aiPrompter(categoryMapperPrompt(analysedReport, categories));
    response.push(categoryList)
    const chosenCategory =  await aiPrompter(appropriateCategoryPrompt(analysedReport, categoryList));
    response.push(chosenCategory)
    const additionalDetails = await aiPrompter(MoreDetailsExtractorPrompt(chosenCategory, customerQuery));
    response.push(additionalDetails)
    const finalResponse = await aiPrompter(responsePrompt(chosenCategory, additionalDetails, analysedReport, customerQuery));
    response.push(finalResponse)

    return response
}

runPromptChain("I noticed a charge of $150 on my credit card statement that I don't recognize. It was made last Friday, but I haven't made any purchases that day. Can you help me understand what this charge is for and how to dispute it if it's fraudulent?").then(response => console.log(response));
