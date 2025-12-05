import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import Replicate from 'replicate';

import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// Initialize Replicate client (Fallback)
const defaultReplicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// Helper to get Replicate client for request
const getReplicateClient = (req) => {
    const token = req.headers['x-replicate-token'];
    if (token) {
        return new Replicate({ auth: token });
    }
    // Fallback to server token if available
    if (process.env.REPLICATE_API_TOKEN) {
        return defaultReplicate;
    }
    throw new Error('Replicate API token is missing. Please provide it in the settings.');
};

// Middleware
app.use(cors({
    origin: '*', // Allow all origins for now, tighten this in production if needed
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-replicate-token', 'x-user-id']
}));
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 images

// Debug middleware to log headers
app.use((req, res, next) => {
    console.log(`[Request] ${req.method} ${req.path}`);
    console.log('[Headers] x-replicate-token present:', !!req.headers['x-replicate-token']);
    console.log('[Headers] x-user-id:', req.headers['x-user-id']);
    next();
});

const DATA_DIR = path.join(__dirname, '../data');
const DIST_DIR = path.join(__dirname, '../dist'); // Frontend build directory
console.log('Data directory path:', DATA_DIR);

// Helper to get user directory
const getUserDir = (userId) => path.join(DATA_DIR, userId);
const getUserImagesDir = (userId) => path.join(DATA_DIR, userId, 'images');
const getUserKnowledgeFile = (userId) => path.join(DATA_DIR, userId, 'knowledge.json');
const ERROR_NOTEBOOK_PATH = path.join(DATA_DIR, 'error_notebook.json');

// Ensure data directory exists
fs.ensureDirSync(DATA_DIR);

// Middleware to validate userId
const validateUserId = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ error: 'Missing x-user-id header' });
  }
  // Basic validation to prevent path traversal
  if (!/^[a-zA-Z0-9-]+$/.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId format' });
  }
  req.userId = userId;
  next();
};

// --- Replicate API Endpoints ---

// Helper to stream Replicate output
const streamReplicate = async (res, client, model, input) => {
  try {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');

    for await (const event of client.stream(model, { input })) {
      res.write(event.toString());
    }
    res.end();
  } catch (error) {
    console.error('Replicate stream error:', error);
    if (!res.headersSent) {
        res.status(500).json({ error: error.message });
    } else {
        res.end();
    }
  }
};

// POST /api/analyze-image (Vision Analysis)
app.post('/api/analyze-image', validateUserId, async (req, res) => {
  try {
    const replicateClient = getReplicateClient(req);
    const { images, prompt } = req.body;
    
    // Ensure images is an array
    const imageInputs = Array.isArray(images) ? images : [images];

    // Using openai/gpt-4o-mini for vision analysis
    const input = {
        top_p: 1,
        prompt: prompt,
        messages: [],
        image_input: imageInputs,
        temperature: 1,
        system_prompt: "You are a helpful assistant.",
        presence_penalty: 0,
        frequency_penalty: 0,
        max_completion_tokens: 4096
    };
    
    console.log('Starting analysis with openai/gpt-4o-mini...');
    await streamReplicate(res, replicateClient, "openai/gpt-4o-mini", input);

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper to save Replicate output (Stream or URL) to local file
const saveReplicateOutput = async (outputItem, userId) => {
  if (!outputItem) return null;

  try {
    const filename = `${uuidv4()}.png`;
    const imagesDir = getUserImagesDir(userId);
    await fs.ensureDir(imagesDir);
    const filePath = path.join(imagesDir, filename);

    let buffer;
    if (typeof outputItem === 'string') {
        // If it's a URL, download it
        console.log(`Downloading generated image from: ${outputItem}`);
        const response = await fetch(outputItem);
        if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
        buffer = await response.arrayBuffer();
    } else {
        // If it's a stream/blob/buffer
        buffer = await new Response(outputItem).arrayBuffer();
    }

    await fs.writeFile(filePath, Buffer.from(buffer));
    console.log(`Saved generated image to: ${filePath}`);
    return `/api/images/${userId}/${filename}`;
  } catch (error) {
    console.error('Error saving Replicate output:', error);
    throw error;
  }
};

// Helper to run Replicate prediction with polling for better error handling
const runReplicatePrediction = async (client, model, input) => {
    console.log(`Starting prediction for model: ${model}`);
    let prediction = await client.predictions.create({
        version: undefined, // Let Replicate pick the version for the model path
        model: model,
        input: input
    });

    console.log(`Prediction created: ${prediction.id}`);

    // Poll for completion
    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        prediction = await client.predictions.get(prediction.id);
        // console.log(`Prediction status: ${prediction.status}`);
    }

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
        console.error('Prediction failed/canceled:', prediction.error);
        console.error('Prediction logs:', prediction.logs);
        throw new Error(`Prediction failed: ${prediction.error || 'Unknown error'}`);
    }

    if (!prediction.output) {
        console.error('Prediction succeeded but output is empty. Logs:', prediction.logs);
        throw new Error('Prediction succeeded but returned no output');
    }

    return prediction.output;
};

// POST /api/generate-image (Image Generation)
app.post('/api/generate-image', validateUserId, async (req, res) => {
    try {
        const replicateClient = getReplicateClient(req);
        const { prompt, aspect_ratio, image_input } = req.body;

        // Using 'google/nano-banana' as requested
        const input = {
            prompt: prompt,
            aspect_ratio: aspect_ratio || "3:4",
            output_format: "jpg",
            // If image_input is provided (as array of URLs), include it
            ...(image_input && Array.isArray(image_input) && image_input.length > 0 ? { image_input } : {})
        };

        console.log('Generating with google/nano-banana, input:', JSON.stringify(input, null, 2));

        // Use the polling helper instead of replicate.run
        const output = await runReplicatePrediction(replicateClient, "google/nano-banana", input);
        
        console.log('Replicate Output:', JSON.stringify(output, null, 2));

        // Handle output (URL or Stream)
        let outputUrl;
        if (Array.isArray(output)) {
            outputUrl = output[0];
        } else if (typeof output === 'object' && output.url) {
            outputUrl = output.url();
        } else {
            outputUrl = output;
        }

        if (!outputUrl || typeof outputUrl !== 'string') {
            throw new Error(`Invalid output from Replicate: ${JSON.stringify(output)}`);
        }

        const imageUrl = await saveReplicateOutput(outputUrl, req.userId);
        
        res.json({ imageUrl });
        
    } catch (error) {
        console.error('Generation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/retouch-image (Image-to-Image / Inpainting)
app.post('/api/retouch-image', validateUserId, async (req, res) => {
    try {
        const replicateClient = getReplicateClient(req);
        const { image, mask, prompt, strength, image_input } = req.body;
        
        let input;
        let model;

        if (mask) {
            // Inpainting mode using Flux Fill
            console.log('Using Inpainting Mode (Flux Fill)');
            model = "black-forest-labs/flux-fill-dev";
            input = {
                image: image,
                mask: mask,
                prompt: prompt,
                guidance: 30, // Standard for Flux Fill
                output_format: "jpg",
                aspect_ratio: "3:4" // Optional, but good to keep consistent
            };
        } else {
            // User requested model: google/nano-banana
            console.log('Using Creative Mode (google/nano-banana)');
            model = "google/nano-banana";
            
            // Construct image_input array: [Master Image, ...Fusion Images]
            const inputs = [image];
            if (image_input && Array.isArray(image_input)) {
                inputs.push(...image_input);
            }

            input = {
                prompt: prompt,
                image_input: inputs,
                aspect_ratio: "match_input_image",
                output_format: "jpg"
            };
        }

        console.log(`Retouching with ${model}, input keys:`, Object.keys(input));

        // Use the polling helper instead of replicate.run
        const output = await runReplicatePrediction(replicateClient, model, input);
        
        console.log('Replicate Output (Retouch):', JSON.stringify(output, null, 2));

        let outputUrl;
        if (Array.isArray(output)) {
            outputUrl = output[0];
        } else if (typeof output === 'object' && output.url) {
            outputUrl = output.url();
        } else {
            outputUrl = output;
        }

        if (!outputUrl || typeof outputUrl !== 'string') {
            throw new Error(`Invalid output from Replicate: ${JSON.stringify(output)}`);
        }

        const imageUrl = await saveReplicateOutput(outputUrl, req.userId);
        res.json({ imageUrl });

    } catch (error) {
        console.error('Retouch error:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- End Replicate Endpoints ---


// GET /api/knowledge
app.get('/api/knowledge', validateUserId, async (req, res) => {
  try {
    const knowledgeFile = getUserKnowledgeFile(req.userId);
    if (await fs.pathExists(knowledgeFile)) {
      const data = await fs.readJson(knowledgeFile);
      res.json(data);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error('Error reading knowledge base:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/knowledge
app.post('/api/knowledge', validateUserId, async (req, res) => {
  try {
    const entries = req.body;
    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: 'Expected an array of entries' });
    }

    const imagesDir = getUserImagesDir(req.userId);
    await fs.ensureDir(imagesDir);

    // Process entries: extract base64 images and save as files
    const processedEntries = await Promise.all(entries.map(async (entry) => {
      if (entry.sourceImagePreview && entry.sourceImagePreview.startsWith('data:image')) {
        // Extract base64 data
        const matches = entry.sourceImagePreview.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1];
          const data = matches[2];
          const filename = `${uuidv4()}.${ext}`;
          const filePath = path.join(imagesDir, filename);
          
          await fs.writeFile(filePath, data, 'base64');
          
          // Update entry with URL
          return {
            ...entry,
            sourceImagePreview: `/api/images/${req.userId}/${filename}`
          };
        }
      }
      return entry;
    }));

    // Save updated JSON
    const knowledgeFile = getUserKnowledgeFile(req.userId);
    await fs.ensureDir(path.dirname(knowledgeFile));
    await fs.writeJson(knowledgeFile, processedEntries, { spaces: 2 });

    res.json(processedEntries);
  } catch (error) {
    console.error('Error saving knowledge base:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Error Notebook Endpoints ---

// POST /api/error-notebook (Add Entry)
app.post('/api/error-notebook', async (req, res) => {
    try {
        const { issue, solution, tags } = req.body;
        if (!issue || !solution) {
            return res.status(400).json({ error: 'Issue and solution are required' });
        }

        await fs.ensureFile(ERROR_NOTEBOOK_PATH);
        let notebook = [];
        try {
            notebook = await fs.readJson(ERROR_NOTEBOOK_PATH);
        } catch (e) {
            notebook = [];
        }

        const newEntry = {
            id: uuidv4(),
            issue,
            solution,
            timestamp: new Date().toISOString(),
            tags: tags || []
        };

        notebook.push(newEntry);
        await fs.writeJson(ERROR_NOTEBOOK_PATH, notebook, { spaces: 2 });
        
        console.log(`Added entry to error notebook: ${issue}`);
        res.json(newEntry);
    } catch (error) {
        console.error('Error writing to error notebook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/error-notebook (Get Entries)
app.get('/api/error-notebook', async (req, res) => {
    try {
        if (await fs.pathExists(ERROR_NOTEBOOK_PATH)) {
            const notebook = await fs.readJson(ERROR_NOTEBOOK_PATH);
            res.json(notebook);
        } else {
            res.json([]);
        }
    } catch (error) {
        console.error('Error reading error notebook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Serve user images
app.get('/api/images/:userId/:filename', async (req, res) => {
  const { userId, filename } = req.params;
  
  // Security check
  if (!/^[a-zA-Z0-9-]+$/.test(userId) || !/^[a-zA-Z0-9-.]+$/.test(filename)) {
    return res.status(400).send('Invalid parameters');
  }

  const filePath = path.join(getUserImagesDir(userId), filename);
  
  if (await fs.pathExists(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Image not found');
  }
});

// Serve static frontend files AFTER API routes
if (fs.existsSync(DIST_DIR)) {
    console.log('Serving static files from:', DIST_DIR);
    app.use(express.static(DIST_DIR));
} else {
    console.warn('Warning: dist directory not found. Frontend will not be served.');
}

// Catch-all handler for SPA client-side routing
// This must be the LAST route handler
app.get('*', (req, res) => {
    if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        res.sendFile(path.join(DIST_DIR, 'index.html'));
    } else {
        res.status(404).send('Frontend not found (dist directory missing)');
    }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
