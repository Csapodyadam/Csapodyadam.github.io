/**
 * =============================================
 *  PORTFOLIO DATA — edit this file to update
 *  your portfolio without touching HTML/CSS
 * =============================================
 */

// ── PROJECTS ──────────────────────────────────
const PROJECTS = [
  {
    title: "CV Display PCB",
    description:
      "A custom PCB business card built around an ESP32 that displays a digital CV and QR code on a TFT screen. Features an onboard LiPo charging IC and LDO regulator for a self-contained, portable form factor. Programmed in C++ via Arduino IDE.",
    tags: ["Altium Designer", "ESP32", "C++", "Hardware"],
    image: "",
    placeholderLabel: "PCB Design",
    links: [],
    page: "projects/cv-display-pcb.html",
    featured: true,
  },
  {
    title: "Op-Amp IC Tester",
    description:
      "A test PCB for verifying the functionality of operational amplifier ICs. Configures the device under test as a Schmitt trigger — a passing IC drives LED indicators. Validated with a full SPICE simulation in LTSpice prior to fabrication.",
    tags: ["KiCad", "LTSpice", "Analog", "Hardware"],
    image: "",
    placeholderLabel: "PCB Design",
    links: [],
    page: "projects/opamp-tester.html",
    featured: false,
  },
  {
    title: "Quill — AI Writing Studio",
    description:
      "A locally-hosted AI writing assistant built with Streamlit and Ollama. Generates and refines long-form prose in four voice styles (Storytelling, Professional, Minimalist, Witty) using a local Llama 3.1 8B model. Features inline refinement, a synonym lab, session history timeline, and a full dark/light theme. Developed iteratively across six versions.",
    tags: ["Python", "Streamlit", "Ollama", "NLP"],
    image: "",
    placeholderLabel: "AI Writing",
    links: [],
    page: "projects/quill-ai-writer.html",
    featured: false,
  },
];

// ── SKILLS ────────────────────────────────────
const SKILLS = [
  {
    category: "Hardware & EDA",
    items: ["Altium Designer", "LTSpice", "PCB Layout", "Schematic Capture", "Analog Circuits", "Power Electronics"],
  },
  {
    category: "Programming",
    items: ["C++", "Arduino IDE", "MATLAB"],
  },
  {
    category: "Domain Knowledge",
    items: ["Electrical Design", "Sustainable Electronics", "Circuit Simulation"],
  },
];

// ── TYPED ROLE STRINGS ────────────────────────
const ROLES = [
  "Electrical Design Engineer",
  "PCB Designer",
  "MSc Student @ BME",
];
