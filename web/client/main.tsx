import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { registerPwa } from "./pwa"
import { webBase } from "./base"
import "./styles.css"

const root = document.getElementById("root")
if (!root) throw new Error("Workspace root is missing")
const pwa = registerPwa(webBase)
createRoot(root).render(<StrictMode><App pwa={pwa} /></StrictMode>)
