import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"

export function App() {
  return <main id="workspace"><h1>Switchboard</h1></main>
}

const root = document.getElementById("root")
if (!root) throw new Error("Workspace root is missing")
createRoot(root).render(<StrictMode><App /></StrictMode>)
