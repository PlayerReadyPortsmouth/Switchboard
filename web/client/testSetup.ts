import { expect } from "bun:test"
import * as matchers from "@testing-library/jest-dom/matchers"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

if (typeof document === "undefined") GlobalRegistrator.register({ url: "http://localhost/" })
expect.extend(matchers)
