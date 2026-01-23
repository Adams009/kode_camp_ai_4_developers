import dotenv from "dotenv";

dotenv.config();
import express from "express";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json());

// ---------------------------------------------
// GOOGLE GEN AI SETUP
// ---------------------------------------------
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// ------------------
// Tool Logic
// ------------------
const getFlightSchedule = ({ origin, destination }) => ({
  origin,
  destination,
  flight_time_hours: 5.5,
  price_usd: 920,
});

const getHotelSchedule = ({ city }) => ({
  city,
  hotels: [
    { name: "Nairobi Serena", price_usd: 250 },
    { name: "Radisson Blu", price_usd: 200 },
  ],
});

const convertCurrency = ({ amount, from_currency, to_currency }) => {
  const rates = { USD_NGN: 925 };
  return {
    amount_converted: amount * rates[`${from_currency}_${to_currency}`],
    currency: to_currency,
  };
};

// ------------------
// Tool Definitions
// ------------------
const tools = [
  {
    functionDeclarations: [
      {
        name: "get_flight_schedule",
        description: "Returns flight duration and USD price",
        parameters: {
          type: "object",
          properties: {
            origin: { type: "string" },
            destination: { type: "string" },
          },
          required: ["origin", "destination"],
        },
      },
      {
        name: "get_hotel_schedule",
        description: "Get hotel options for a city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
      {
        name: "convert_currency",
        description: "Convert currencies",
        parameters: {
          type: "object",
          properties: {
            amount: { type: "number" },
            from_currency: { type: "string" },
            to_currency: { type: "string" },
          },
          required: ["amount", "from_currency", "to_currency"],
        },
      },
    ],
  },
];

// ---------------------------------------------
// Send message that triggers tool calls
// --------------------------------------------

async function callModel(contents) {
  return ai.models.generateContent({
    model: process.env.LLM_MODEL_NAME,
    contents,
    config: {
      tools,
      toolConfig: {
        functionCallingConfig: { mode: "AUTO" },
      },
    },
  });
}

const prompts =
  "I'm taking a flight from Lagos to Nairobi for a conference. I would like to know the total flight time back and forth, and the total cost of logistics for this conference if I'm staying for three days.";

const userMessage = {
  role: "user",
  parts: [{ text: prompts }],
};

try {
  let response = await callModel([userMessage]);

  const parts = response.candidates[0].content.parts;
  console.log("AI Response:", JSON.stringify(parts, null, 2));

  // -----------------------------------
  // function call check
  // ----------------------------------
  function extractFunctionCall(parts) {
    return parts.find((p) => p.functionCall)?.functionCall;
  }

  let functionCall = extractFunctionCall(parts);

  if (!functionCall) {
    console.log("No function call, final text:", parts[0].text);
    process.exit(0);
  }

  console.log("Tool requested:", functionCall.name);
  console.log("Arguments:", functionCall.args);

  // -----------------------------------
  // function names to implementations
  // ----------------------------------
  const toolHandlers = {
    get_flight_schedule: getFlightSchedule,
    get_hotel_schedule: getHotelSchedule,
    convert_currency: convertCurrency,
  };

  function executeTool(functionCall) {
    const handler = toolHandlers[functionCall.name];

    if (!handler) {
      throw new Error(`No handler for tool: ${functionCall.name}`);
    }

    if (!functionCall.args) {
      throw new Error(`No arguments provided for tool: ${functionCall.name}`);
    }

    if (typeof handler !== "function") {
      throw new Error(
        `Handler for tool ${functionCall.name} is not a function`,
      );
    }

    if (typeof functionCall.args !== "object") {
      throw new Error(
        `Arguments for tool ${functionCall.name} must be an object`,
      );
    }

    return handler(functionCall.args);
  }

  let toolResult = executeTool(functionCall);

  console.log("Tool result:", toolResult);

  // -----------------------------------
  // Send tool result back to AI
  // -----------------------------------
  function toolResponseMessage(name, response) {
    return {
      role: "model",
      parts: [{ functionResponse: { name, response } }],
    };
  }

  const responseMessage = toolResponseMessage(functionCall.name, toolResult);

  let initialConversation = [userMessage, responseMessage];

  let followUpResponse = await callModel(initialConversation);

  let followUpParts = followUpResponse.candidates[0].content.parts;

  // ---------------------------------------------
  // check for further function call or final answer
  // ---------------------------------------------
  while (true) {
    functionCall = undefined
    functionCall = extractFunctionCall(followUpParts);

    if (!functionCall) {
      console.log("No function call, final text:", followUpParts[0].text);
      break;
    }

    console.log("Tool requested:", functionCall.name);
    console.log("Arguments:", functionCall.args);

    // -----------------------------------
    // function names to implementations
    // ----------------------------------
    let toolResult = executeTool(functionCall);
    console.log("Tool result:", toolResult);
    // -----------------------------------
    // Send tool result back to AI
    // -----------------------------------
    initialConversation.push(
      toolResponseMessage(functionCall.name, toolResult),
    );

    followUpResponse = await callModel(initialConversation);
    followUpParts = followUpResponse.candidates[0].content.parts;
  }
} catch (error) {
  console.error("Error during AI interaction:", error);
}
app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
