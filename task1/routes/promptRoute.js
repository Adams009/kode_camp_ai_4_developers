import {Router} from "express"
import getPromptResponse from "../controllers/promptController.js";

const router = Router()

router.post("/prompt", getPromptResponse)

export default router