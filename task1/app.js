import express from "express";
import cors from "cors"
import envConfig from "./configs/envConfig.js";
import promptRoute from "./routes/promptRoute.js";

const app = express()

app.use(express.json());

app.use(cors())

app.use("/api", promptRoute)

const PORT = envConfig.port

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});