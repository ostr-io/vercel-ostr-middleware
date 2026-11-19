// Maps `@vercel/functions` to a local stub, so the tests run with no npm install
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
