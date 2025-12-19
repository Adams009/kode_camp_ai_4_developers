
// Endpoints: /upload, /prompt, /rechunk
import dotenv from "dotenv";

dotenv.config();
import express from 'express'
import fs from 'node:fs/promises'; // read file from the disk
import path from "path"; // to work with file path/dir
import mammoth from "mammoth"; // to extract text from docx file
import multer from "multer";
import { pipeline } from "@huggingface/transformers";
import { GoogleGenAI } from "@google/genai";
import { DefaultEmbeddingFunction } from "@chroma-core/default-embed";
import { ChromaClient} from "chromadb";
import { PDFParse } from 'pdf-parse';
import crypto from "node:crypto";

const app = express();
app.use(express.json());


// ---------------------------------------------
// CHROMA SETUP
// ---------------------------------------------

const client = new ChromaClient({
  path: process.env.CHROMA_DB_HOST
});


const collection = await client.getOrCreateCollection({
    name: "documents",
  });

// ---------------------------------------------
// EMBEDDING PIPELINE
// ---------------------------------------------
const embedder = await pipeline(
  process.env.EMBED_TASK,          // "feature-extraction"
  process.env.EMBED_MODEL_NAME,    // "Xenova/all-MiniLM-L6-v2"
  { apiKey: process.env.HF_API_KEY }
);

// ---------------------------------------------
// GOOGLE GEN AI SETUP
// ---------------------------------------------
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});


// ---------------------------------------------
// READ & PARSE FILE CONTENT
// ---------------------------------------------

async function extractPdfText(filePath) {
  try {
    // Read file into buffer
    const buffer = await fs.readFile(filePath);

    // Create parser instance
    const parser = new PDFParse({ data: buffer });

    // Extract text
    const textResult = await parser.getText();

    // Extract metadata & page info
    const infoResult = await parser.getInfo();

    await parser.destroy();

    console.log(`Pages: ${infoResult.total}`);
    console.log(`Author: ${infoResult.info?.Author || "Unknown"}`);
    console.log("Preview:", textResult.text.slice(0, 200));

    if (textResult.text.trim().length === 0) {
      console.warn("PDF has no extractable text:", filePath);
      return "";
    }
    return textResult.text;
  } catch (err) {
    console.error("PDF parse failed:", err);
    return "";
  }
}

async function readFileContent(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".txt" || ext === ".md") {
    return await fs.readFile(filePath, "utf8");
  }

  if (ext === ".pdf") {
    const text = await extractPdfText(filePath);

    if (!text || text.trim().length === 0) {
      console.warn("PDF has no extractable text:", filePath);
      return "";
    }
    return text;
  }

  if (ext === ".docx") {
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });

    if (!result.value || result.value.trim().length === 0) {
      console.warn("DOCX has no extractable text:", filePath);
      return "";
    }
    return result.value;
  }

  return "";
}

// ---------------------------------------------
// LOAD ALL DOCUMENTS BY CATEGORY (FOLDER NAME)
// ---------------------------------------------

async function loadAllDocumentsWithCategory(dir, category = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const allDocs = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const subCategory = category
        ? `${category}/${entry.name}`
        : entry.name;

      const subDocs = await loadAllDocumentsWithCategory(
        fullPath,
        subCategory
      );
      allDocs.push(...subDocs);
      continue;
    }

    const text = await readFileContent(fullPath);
    if (!text || text.trim().length === 0) continue;

    allDocs.push({
      filename: entry.name,
      category,
      content: text
    });
  }

  return allDocs;
}

// ---------------------------------------------
// CHUNKING
// ---------------------------------------------
const CHUNK_LENGTH = parseInt(process.env.CHUNK_LENGTH || "500");
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || "50");

function chunkText(text, size, overlap = 0) {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/);

  const chunks = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > size) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }

      if (overlap > 0 && chunks.length > 0) {
        currentChunk = currentChunk
          .slice(-overlap)
          .trim();
      } else {
        currentChunk = "";
      }
    }

    currentChunk += sentence + " ";
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}


function chunkAllDocuments(documents, size = CHUNK_LENGTH, overlap =CHUNK_OVERLAP ) {
  const allChunks = [];

  documents.forEach(doc => {
    const chunks = chunkText(
      doc.content,
      size,
      overlap
    );

    chunks.forEach((chunk, index) => {
      allChunks.push({
        filename: doc.filename,
        category: doc.category,
        chunkIndex: index,
        content: chunk
      });
    });
  });

  return allChunks;
}



// ---------------------------------------------
// EMBEDDING
// ---------------------------------------------

async function embedChunk(text) {
  try {
    const embeddingResult = await embedder(text, {
      pooling: "mean",
      normalize: true,
    });

    const tensor = embeddingResult?.ort_tensor;
    if (!tensor) {
      throw new Error("No tensor returned");
    }

    // dims is [1, 384]
    return Array.from(tensor.cpuData);

  } catch (err) {
    console.error("Embedding failed:", err);
    return null;
  }
}

const EMBED_BATCH_SIZE = 16;

async function embedAllChunks(chunks) {
  const embedded = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);

    const vectors = await Promise.all(
      batch.map(c => embedChunk(c.content))
    );

    vectors.forEach((vector, idx) => {
      if (!vector) return;

      embedded.push({
        ...batch[idx],
        embedding: vector
      });
    });
  }

  return embedded;
}


// ---------------------------------------------
// SAVE TO CHROMA
// ---------------------------------------------


function makeChunkId(chunk) {
  const raw = `${chunk.filename}|${chunk.category}|${chunk.chunkIndex}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}
async function saveToChroma(embeddedChunks) {
  if (!embeddedChunks.length) {
    console.warn("No chunks to save to Chroma");
    return;
  }

  const ids = [];
  const embeddings = [];
  const metadatas = [];
  const documents = [];

  for (const chunk of embeddedChunks) {
    if (!chunk.embedding || !chunk.embedding.length) continue;

    ids.push(makeChunkId(chunk));
    embeddings.push(chunk.embedding);
    documents.push(chunk.content);
    metadatas.push({
      filename: chunk.filename,
      category: chunk.category,
      chunkIndex: chunk.chunkIndex,
      model: "all-MiniLM-L6-v2"
    });
  }

  if (
    !ids.length ||
    ids.length !== embeddings.length ||
    ids.length !== metadatas.length ||
    ids.length !== documents.length
  ) {
    throw new Error("Chroma data arrays mismatch or empty");
  }

  await collection.add({
    ids,
    embeddings,
    documents,
    metadatas
  });

  console.log(`Saved ${ids.length} chunks to Chroma`);
}



// ---------------------------------------------
// INITIAL BULK LOAD (IT IS OPTIONAL) NOT NEEDED SINCE ALREADY USE PERSIST ON THE CHROMADB 
// ---------------------------------------------
// if (process.env.RAG_DATA_DIR) {
//   const docs = await loadAllDocumentsWithCategory(process.env.RAG_DATA_DIR);
//   const chunks = chunkAllDocuments(docs);
//   const embeddedChunks = await embedAllChunks(chunks);
//   await saveToChroma(embeddedChunks);
// }


// ---------------------------------------------
// FILE UPLOAD ENDPOINT
// ---------------------------------------------
const upload = multer({ dest: "tmp_uploads/" });

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const category = req.body.category;
    const file = req.file;

    if (!category || !file) {
      return res.status(400).json({ error: "category and file are required" });
    }

    const categoryPath = path.join(process.env.RAG_DATA_DIR, category);

    try {
  await fs.access(categoryPath); // throws if folder does not exist
} catch {
  await fs.mkdir(categoryPath, { recursive: true });
}

    const finalPath = path.join(categoryPath, file.originalname);
    await fs.rename(file.path, finalPath);


    // process only this file
    const text = await readFileContent(finalPath);

    if (!text) {
      return res.status(400).json({ error: "Uploaded file has no extractable text." });
    }
    const chunks = chunkText(text, CHUNK_LENGTH);

    if (!chunks.length) {
      return res.status(400).json({ error: "No chunks could be created from this file." });
    }

    const prepared = chunks.map((c, i) => ({
  filename: file.originalname,
  category,
  chunkIndex: i,
  content: c
}));
    
    const embedded = await embedAllChunks(prepared);

if (!embedded.length) {
  return res.status(500).json({ error: "Failed to generate embeddings for file." });
}

await saveToChroma(embedded);
return res.json({ message: "File uploaded and processed." });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Upload failed" });
  }
});


// ---------------------------------------------
// /prompt — RAG answer generation
// ---------------------------------------------
// 
app.post("/prompt", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: "question is required" });
    }

    // ---------------------------------------------------------
    // 1. Embed the question
    // ---------------------------------------------------------
    const queryEmbedding = await embedChunk(question);

    if (!queryEmbedding || !queryEmbedding.length) {
      return res.status(500).json({ error: "Failed to embed question" });
    }

    // ---------------------------------------------------------
    // 2. Query Chroma
    // ---------------------------------------------------------
    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: 5
    });

    const docs = results.documents?.[0] || [];
    const metas = results.metadatas?.[0] || [];

    // ---------------------------------------------------------
    // 3. Build context
    // ---------------------------------------------------------
    let contextText = "";

    docs.forEach((doc, idx) => {
      const meta = metas[idx] || {};
      contextText +=
`Source: ${meta.filename || "unknown"}
Category: ${meta.category || "unknown"}
Chunk: ${meta.chunkIndex ?? "?"}

${doc}\n------------------------------------------------\n

`;
    });

    if (!contextText.trim()) {
      contextText = "No relevant documents found.";
    }

    // ---------------------------------------------------------
    // 4. Generate answer (RAG-safe prompt)
    // ---------------------------------------------------------
    const response = await ai.models.generateContent({
      model: process.env.LLM_MODEL_NAME,
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
`You are a retrieval-augmented assistant.
Answer ONLY using the provided context.
If the answer is not present, reply exactly:
"The answer is not available in the provided documents."

Question:
${question}

Context:
${contextText}`
            }
          ]
        }
      ]
    });

    const answer =
      response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "The answer is not available in the provided documents.";

    // ---------------------------------------------------------
    // 5. Response
    // ---------------------------------------------------------
    return res.json({
      answer,
      sources: metas.map(m => ({
        filename: m.filename,
        category: m.category,
        chunkIndex: m.chunkIndex
      }))
    });

  } catch (error) {
    console.error("Prompt error:", error);
    return res.status(500).json({
      error: "Prompt failed",
      details: error.message
    });
  }
});





// Rechunk endpoint
app.post("/rechunk", async (req, res) => {
  try {
    const { chunkLength, chunkOverlap, specificFile, specificCategory } = req.body;
    const CHUNK_LENGTH = parseInt(chunkLength) || parseInt(process.env.CHUNK_LENGTH) || 500;
    const CHUNK_OVERLAP = parseInt(chunkOverlap) || parseInt(process.env.CHUNK_OVERLAP) || 50;
    // await collection.delete({ where: {} });

    const docs = await loadAllDocumentsWithCategory(
      process.env.RAG_DATA_DIR
    );

    if (specificCategory) docs = docs.filter(d => d.category === specificCategory);
    if (specificFile) docs = docs.filter(d => d.filename === specificFile);
    if (!docs.length) return res.status(404).json({ message: "No matching documents found" });

    const chunks = chunkAllDocuments(docs, CHUNK_LENGTH, CHUNK_OVERLAP);
    const embedded = await embedAllChunks(chunks);

    await saveToChroma(embedded);

    res.json({
       message: "Rechunk completed",
       documents: docs.length,
       chunks: chunks.length,
       chunkLength: CHUNK_LENGTH,
       chunkOverlap: CHUNK_OVERLAP
     })
  } catch (err) {
    console.error("Rechunk failed:", err);
    return res.status(500).json({ error: "Rechunk failed", details: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


