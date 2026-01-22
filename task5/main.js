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

const prompts =
  "I'm taking a flight from Lagos to Nairobi for a conference. I would like to know the total flight time back and forth, and the total cost of logistics for this conference if I'm staying for three days.";

const response = await ai.models.generateContent({
  model: process.env.LLM_MODEL_NAME,
  contents: [
    {
      role: "user",
      parts: [{ text: prompts }],
    },
  ],
  config: {
    tools: tools,
    toolConfig: {
      functionCallingConfig: {
        mode: "AUTO",
      },
    },
  },
});

const parts = response.candidates[0].content.parts;
console.log("AI Response:", JSON.stringify(parts, null, 2));

// -----------------------------------
// function call check
// ----------------------------------
let functionCall;
for (const part of parts) {
  if (part.functionCall) {
    functionCall = part.functionCall;
    break;
  }
}

if (!functionCall) {
  console.log("No function call, final text:", parts[0].text);
  process.exit(0);
}

console.log("Tool requested:", functionCall.name);
console.log("Arguments:", functionCall.args);

// -----------------------------------
// function names to implementations
// ----------------------------------
let toolResult;

if (functionCall.name === "get_flight_schedule") {
  toolResult = getFlightSchedule(functionCall.args);
}

if (functionCall.name === "get_hotel_schedule") {
  toolResult = getHotelSchedule(functionCall.args);
}

if (functionCall.name === "convert_currency") {
  toolResult = convertCurrency(functionCall.args);
}

console.log("Tool result:", toolResult);

// -----------------------------------
// Send tool result back to AI
// -----------------------------------

const conversation = [
  {
    role: "user",
    parts: [{ text: prompts }],
  },
  {
    role: "model",
    parts: [
      {
        functionResponse: {
          name: functionCall.name,
          response: toolResult,
        },
      },
    ],
  },
];

let followUpResponse = await ai.models.generateContent({
  model: process.env.LLM_MODEL_NAME,
  contents: conversation,
  config: {
    tools: tools,
    toolConfig: {
      functionCallingConfig: {
        mode: "AUTO",
      },
    },
  },
});

let followUpParts = followUpResponse.candidates[0].content.parts;

// ---------------------------------------------
// check for further function call or final answer
// ---------------------------------------------
let check = true;
do {
  functionCall = undefined;
  for (const part of followUpParts) {
    if (part.functionCall) {
      functionCall = part.functionCall;
      break;
    }
  }

  if (!functionCall) {
    console.log("final text:", followUpParts[0].text);
    check = false;
    break;
  }

  console.log("Tool requested:", functionCall.name);
  console.log("Arguments:", functionCall.args);

  // -----------------------------------
  // function names to implementations
  // ----------------------------------
  let toolResult;

  if (functionCall.name === "get_flight_schedule") {
    toolResult = getFlightSchedule(functionCall.args);
  }

  if (functionCall.name === "get_hotel_schedule") {
    toolResult = getHotelSchedule(functionCall.args);
  }

  if (functionCall.name === "convert_currency") {
    toolResult = convertCurrency(functionCall.args);
  }

  console.log("Tool result:", toolResult);

  // -----------------------------------
  // Send tool result back to AI
  // -----------------------------------

  conversation.push({
    role: "model",
    parts: [
      {
        functionResponse: {
          name: functionCall.name,
          response: toolResult,
        },
      },
    ],
  });

  followUpResponse = await ai.models.generateContent({
    model: process.env.LLM_MODEL_NAME,
    contents: conversation,
    config: {
      tools: tools,
      toolConfig: {
        functionCallingConfig: {
          mode: "AUTO",
        },
      },
    },
  });

  followUpParts = followUpResponse.candidates[0].content.parts;
} while (check);
app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
