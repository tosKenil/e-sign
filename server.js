require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const mime = require("mime-types");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const ejs = require("ejs");
const { SIGN_EVENTS } = require("./contance.js");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors({
    origin: [
        "http://localhost:3000",
        "https://e-sign-eight.vercel.app"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
}));

// -------------------- ENV CONFIG --------------------
const PORT = process.env.PORT || 4011;
const BASE_URL = process.env.BASE_URL || `https://e-sign-eight.vercel.app`;
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
const expireTime = { expiresIn: "100m" };

// -------------------- STORAGE PATHS --------------------
const STORAGE_DIR = path.join(__dirname, "storage");
const ORIGINALS_DIR = path.join(STORAGE_DIR, "originals");
const SIGNED_DIR = path.join(STORAGE_DIR, "signed");

(async () => {
    await fsp.mkdir(ORIGINALS_DIR, { recursive: true });
    await fsp.mkdir(SIGNED_DIR, { recursive: true });
})();

// -------------------- DATABASE --------------------
mongoose
    .connect(process.env.DB_URL)
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });

// -------------------- SCHEMA --------------------
const envelopeSchema = new mongoose.Schema(
    {
        recipientEmail: String,
        recipientName: String,
        documentStatus: { type: String, default: SIGN_EVENTS.SENT },
        files: [
            {
                filename: String,
                storedName: String,
                publicUrl: String,
                mimetype: String,
            },
        ],
        signedPdf: { filename: String, publicUrl: String },
    },
    { timestamps: true }
);
const Envelope = mongoose.model("envelope", envelopeSchema);

// -------------------- HELPERS --------------------
function generateId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function verifyJWT(req, res, next) {
    const token = req.params.token;
    if (!token) return res.status(401).json({ error: "Missing token" });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: "Invalid token" });
        req._id = decoded._id;
        next();
    });
}

// -------------------- STATIC ROUTES --------------------
app.use("/storage", express.static(STORAGE_DIR, { fallthrough: true }));
app.use("/form", express.static(path.join(__dirname, "web/form")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "web", "form.html"));
});

// -------------------- MULTER UPLOAD CONFIG --------------------
const uploadSignedFile = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, SIGNED_DIR);
        },
        filename: (req, file, cb) => {
            const uniqueName = `${Date.now()}-${generateId()}.pdf`;
            cb(null, uniqueName);
        },
    }),
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== ".pdf") return cb(new Error("Only PDF files allowed"));
        cb(null, true);
    },
});

// -------------------- ROUTES --------------------

// --- Generate multiple templates ---
app.post("/api/generate-template", uploadSignedFile.none(), async (req, res) => {
    console.log("-0---------------")
    console.log("-0---------------", `${BASE_URL}/storage/originals`)
    try {
        const { templates, name, address, company_name, uen, reg_address, date } = req.body;

        let selected;
        try {
            selected = JSON.parse(templates);
        } catch {
            selected = templates
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }

        if (!Array.isArray(selected) || selected.length === 0)
            return res.status(400).json({ error: "Select at least one template" });

        const files = [];
        for (const type of selected) {
            const tplPath = path.join(__dirname, "templates", `${type}.html`);
            if (!fs.existsSync(tplPath)) continue;

            const raw = await fsp.readFile(tplPath, "utf8");
            const html = ejs.render(raw, {
                name,
                address,
                reg_address,
                company_name,
                uen,
                date,
            });

            const fileName = `${Date.now()}-${generateId()}-${type}.html`;
            const outPath = path.join(ORIGINALS_DIR, fileName);
            await fsp.writeFile(outPath, html);

            console.log("=====================", `${BASE_URL}/storage/originals/${fileName}`)

            // files.push({
            //     filename: fileName,
            //     storedName: fileName,
            //     publicUrl: `${BASE_URL}/storage/originals/${fileName}`,
            //     mimetype: "text/html",
            // });
        }

        if (files.length === 0)
            return res.status(404).json({ error: "No templates found" });

        const env = await Envelope.create({
            recipientEmail: "demo@user.com",
            recipientName: name,
            files,
            documentStatus: SIGN_EVENTS.SENT,
        });

        const token = jwt.sign({ _id: env._id }, JWT_SECRET, expireTime);
        const signUrl = `${BASE_URL}/sign/${token}`;

        res.json({ ok: true, signUrl });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Generation failed" });
    }
});

// --- Read envelope ---
app.get("/api/envelopes/by-token/:token", verifyJWT, async (req, res) => {
    const env = await Envelope.findById(req._id);
    if (!env) return res.status(404).json({ error: "Envelope not found" });

    res.json({
        recipientEmail: env.recipientEmail,
        recipientName: env.recipientName,
        files: env.files.map((f) => ({
            url: f.publicUrl,
            mimetype: f.mimetype,
        })),
    });
});

app.post("/api/envelopes/:token/complete", verifyJWT, uploadSignedFile.single("file"), async (req, res) => {
    try {
        const env = await Envelope.findById(req._id);
        if (!env) return res.status(404).json({ error: "Envelope not found" });

        env.signedPdf = {
            filename: req.file.filename,
            publicUrl: `${BASE_URL}/storage/signed/${req.file.filename}`,
        };
        env.documentStatus = SIGN_EVENTS.COMPLETED;
        await env.save();

        res.json({ ok: true, downloadUrl: env.signedPdf.publicUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Upload failed" });
    }
}
);

// --- Cancel envelope ---
app.post("/api/envelopes/:token/cancel", verifyJWT, async (req, res) => {
    const env = await Envelope.findById(req._id);
    if (!env) return res.status(404).json({ error: "Envelope not found" });

    env.documentStatus = SIGN_EVENTS.VOIDED;
    await env.save();

    res.json({ ok: true, message: "Cancelled" });
});

// --- Serve signing page ---
app.get("/sign/:token", (req, res) => {
    jwt.verify(req.params.token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).send("Link expired");
        res.sendFile(path.join(__dirname, "web", "sign.html"));
    });
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => console.log(`🚀 Server running at ${BASE_URL}`));
