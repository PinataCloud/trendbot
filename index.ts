import { PinataSDK } from "pinata";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import dotenv from "dotenv";
import cron from "node-cron";
import { createCanvas, loadImage, registerFont } from "canvas";
import fs from "node:fs";
import path from "node:path";
import FormData from "form-data";
import OpenAI from "openai";
import ora from "ora";
import chalk from "chalk";

// Define interfaces for our data structures
interface Author {
	username: string;
	display_name?: string;
	// Other potential author properties
}

interface Cast {
	text: string;
	hash: string;
	author: Author;
	created_at: string;
	// Other potential cast properties
}

interface LLMResult {
	cast: Cast;
	llmResponse: string;
	tokenName: string;
	imageDescription: string;
}

interface IPFSResult {
	cid: string;
	url: string;
}

interface TokenDeployResult {
	contract: {
		fungible: {
			object: string;
			name: string;
			symbol: string;
			media: string;
			address: string;
			decimals: number;
		};
	};
}

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Initialize clients
const account = privateKeyToAccount(PRIVATE_KEY as `0xstring`);
const fetchWithPayment = wrapFetchWithPayment(fetch, account);
const pinata = new PinataSDK({
	pinataJwt: "",
	pinataGateway: "",
});

// Initialize OpenAI client
const openai = new OpenAI({
	apiKey: "ollama",
	baseURL: "http://localhost:11434/v1",
});

/**
 * Fetch trending casts from Neynar API
 */
const getTrendingCasts = async (): Promise<{ casts: Cast[] }> => {
	const spinner = ora("Fetching trending casts from Neynar...").start();
	try {
		const response = await fetchWithPayment(
			"https://api.neynar.com/v2/farcaster/feed/trending?time_window=24h&provider=neynar",
			{ method: "GET" },
		);
		const paymentResponse = decodeXPaymentResponse(
			response.headers.get("x-payment-response") as string,
		);
		spinner.succeed("Successfully fetched trending casts");
		console.log(chalk.cyan("Payment response:"), paymentResponse);

		const data = await response.json();
		return data;
	} catch (error) {
		spinner.fail("Failed to fetch trending casts");
		console.error(chalk.red("Error fetching trending casts:"), error);
		throw error;
	}
};

/**
 * Use OpenAI to select the cast most likely to make a valuable crypto coin
 */
const selectBestCastWithLLM = async (casts: Cast[]): Promise<LLMResult> => {
	const spinner = ora("Analyzing casts with LLM...").start();
	try {
		// Extract just the text from the top 10 casts
		const castTexts = casts.slice(0, 10).map((cast: Cast, index: number) => {
			return `Cast ${index + 1}: ${cast.text}`;
		});

		const prompt = `
You are a crypto expert tasked with identifying social media content that would make for a valuable crypto coin concept.
Below are trending posts from Farcaster (a social network).
Please analyze these posts and select the ONE that would make the most valuable and interesting crypto coin concept.

${castTexts.join("\n\n")}

Your response should include:
1. The number of the selected cast
2. A brief explanation (2-3 sentences) of why this would make a valuable crypto token
3. A suggested name for the token (should be catchy and crypto-related)
4. A SHORT one-sentence description of an image that would represent this token concept (this will be used to generate an image)
`;

		const response = await openai.chat.completions.create({
			model: "llama3.2",
			messages: [
				{
					role: "system",
					content:
						"You are a crypto market expert with deep knowledge of what makes tokens valuable and viral.",
				},
				{ role: "user", content: prompt },
			],
			temperature: 0.7,
		});

		const llmResponse = response.choices[0].message.content;
		spinner.text = "LLM analysis complete, parsing results...";

		// Parse the response to extract cast number, token name, and image description
		const castNumberMatch = llmResponse?.match(/Cast (\d+)/i);
		const castNumber = castNumberMatch
			? Number.parseInt(castNumberMatch[1], 10) - 1
			: 0;

		const tokenNameMatch = llmResponse?.match(
			/suggested name[^:]*:[^\w]*([^\n.]+)/i,
		);
		const tokenName = tokenNameMatch ? tokenNameMatch[1].trim() : "TrendToken";

		const imageDescMatch = llmResponse?.match(/image[^:]*:[^\w]*([^\n.]+)/i);
		const imageDescription = imageDescMatch
			? imageDescMatch[1].trim()
			: "A trendy crypto token visualization";

		// Get the selected cast
		const selectedCast = casts[castNumber];

		spinner.succeed("Successfully identified the best cast for tokenization");
		console.log(chalk.blue.bold("LLM Response:"));
		console.log(chalk.blue(llmResponse));

		return {
			cast: selectedCast,
			llmResponse: llmResponse || "",
			tokenName,
			imageDescription,
		};
	} catch (error) {
		spinner.fail("LLM analysis failed");
		console.error(chalk.red("Error selecting best cast with LLM:"), error);
		throw error;
	}
};

/**
 * Generate image for the selected cast using canvas
 */
const generateImageForCast = async (
	castInfo: Cast,
	tokenName: string,
): Promise<Buffer> => {
	const spinner = ora(`Generating image for token "${tokenName}"...`).start();
	try {
		// Setup canvas
		const width = 1200;
		const height = 1200;
		const canvas = createCanvas(width, height);
		const ctx = canvas.getContext("2d");

		// Background
		ctx.fillStyle = "#121a2e"; // Darker blue background
		ctx.fillRect(0, 0, width, height);

		// Token name header
		ctx.fillStyle = "#F8FAFC";
		ctx.font = "bold 72px sans-serif";
		ctx.textAlign = "center";
		ctx.fillText(tokenName, width / 2, 120);

		// Divider
		ctx.strokeStyle = "#334155";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(100, 160);
		ctx.lineTo(width - 100, 160);
		ctx.stroke();

		// User info section - username only, no date
		ctx.fillStyle = "#94A3B8";
		ctx.font = "36px sans-serif";
		ctx.textAlign = "left";
		ctx.fillText(`@${castInfo.author.username}`, 120, 220);

		// Display name if available
		if (castInfo.author.display_name) {
			ctx.fillStyle = "#F8FAFC";
			ctx.font = "bold 44px sans-serif";
			const displayName = castInfo.author.display_name;
			// Check if display name is too long
			if (ctx.measureText(displayName).width > width - 240) {
				ctx.font = "bold 36px sans-serif"; // Reduce font size if too long
			}
			ctx.fillText(displayName, 120, 280);
		}

		// Cast text section
		// Get the cast text
		const castText = castInfo.text || "No cast text available";

		// Set up for text wrapping
		ctx.font = "36px sans-serif";
		ctx.fillStyle = "#F8FAFC";

		// Calculate word wrapping with proper line breaks
		const maxWidth = width - 280; // Increased padding for better readability
		const words = castText.split(" ");
		const lines: string[] = [];
		let currentLine = "";

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			// Handle line breaks in the original text
			if (word.includes("\n")) {
				const parts = word.split("\n");
				if (currentLine) {
					lines.push(`${currentLine}${parts[0] ? ` ${parts[0]}` : ""}`);
					currentLine = "";
				} else if (parts[0]) {
					lines.push(parts[0]);
				}

				// Add the remaining parts as separate lines
				for (let j = 1; j < parts.length - 1; j++) {
					lines.push(parts[j]);
				}

				if (parts.length > 1) {
					currentLine = parts[parts.length - 1];
				}
				continue;
			}

			const testLine = currentLine + (currentLine ? " " : "") + word;
			const metrics = ctx.measureText(testLine);

			if (metrics.width > maxWidth && currentLine !== "") {
				lines.push(currentLine);
				currentLine = word;
			} else {
				currentLine = testLine;
			}
		}

		if (currentLine) {
			lines.push(currentLine);
		}

		// Calculate text box dimensions based on content
		const lineHeight = 48; // Line height for readability
		const textHeight = lines.length * lineHeight;
		const textBoxPadding = 40;

		// Calculate optimal position for the text box
		const textBoxY = 340;

		// Limit the height of the text box to prevent overflow and ensure space for the token
		const maxTextBoxHeight = 460; // Reduced maximum height
		const textBoxHeight = Math.min(
			textHeight + textBoxPadding * 2,
			maxTextBoxHeight,
		);

		// Draw text box with rounded corners
		const cornerRadius = 20;
		ctx.fillStyle = "rgba(30, 41, 59, 0.7)";

		// Rounded rectangle
		ctx.beginPath();
		ctx.moveTo(120 + cornerRadius, textBoxY);
		ctx.lineTo(width - 120 - cornerRadius, textBoxY);
		ctx.quadraticCurveTo(
			width - 120,
			textBoxY,
			width - 120,
			textBoxY + cornerRadius,
		);
		ctx.lineTo(width - 120, textBoxY + textBoxHeight - cornerRadius);
		ctx.quadraticCurveTo(
			width - 120,
			textBoxY + textBoxHeight,
			width - 120 - cornerRadius,
			textBoxY + textBoxHeight,
		);
		ctx.lineTo(120 + cornerRadius, textBoxY + textBoxHeight);
		ctx.quadraticCurveTo(
			120,
			textBoxY + textBoxHeight,
			120,
			textBoxY + textBoxHeight - cornerRadius,
		);
		ctx.lineTo(120, textBoxY + cornerRadius);
		ctx.quadraticCurveTo(120, textBoxY, 120 + cornerRadius, textBoxY);
		ctx.closePath();
		ctx.fill();

		// Draw border
		ctx.strokeStyle = "#475569";
		ctx.lineWidth = 2;
		ctx.stroke();

		// Draw the text lines with proper positioning
		ctx.fillStyle = "#F8FAFC";
		ctx.textAlign = "left";

		// Determine if we need to truncate text (if too many lines)
		const maxVisibleLines = Math.floor(
			(textBoxHeight - textBoxPadding * 2) / lineHeight,
		);
		const visibleLines = lines.slice(0, maxVisibleLines);

		// Display text, possibly truncated
		let y = textBoxY + textBoxPadding + lineHeight / 2; // Adjust starting position
		for (let i = 0; i < visibleLines.length; i++) {
			// Check if this is the last line and we've truncated content
			if (i === maxVisibleLines - 1 && lines.length > maxVisibleLines) {
				// Add ellipsis to indicate truncated text
				let truncatedLine = visibleLines[i];
				while (ctx.measureText(`${truncatedLine}...`).width > maxWidth) {
					truncatedLine = truncatedLine.slice(0, -1);
				}
				ctx.fillText(`${truncatedLine}...`, 120 + textBoxPadding, y);
			} else {
				ctx.fillText(visibleLines[i], 120 + textBoxPadding, y);
			}
			y += lineHeight;
		}

		// Ensure space between text box and token visualization
		const tokenY = textBoxY + textBoxHeight + 100; // Increased spacing

		// Draw token circle
		ctx.beginPath();
		ctx.arc(width / 2, tokenY, 150, 0, Math.PI * 2);

		// Gradient for token
		const tokenGradient = ctx.createRadialGradient(
			width / 2,
			tokenY,
			20,
			width / 2,
			tokenY,
			150,
		);
		tokenGradient.addColorStop(0, "#10B981"); // Green inner
		tokenGradient.addColorStop(0.5, "#3B82F6"); // Blue middle
		tokenGradient.addColorStop(1, "#8B5CF6"); // Purple outer
		ctx.fillStyle = tokenGradient;
		ctx.fill();

		// White stroke around token
		ctx.strokeStyle = "#FFFFFF";
		ctx.lineWidth = 5;
		ctx.stroke();

		// Add token symbol in the center
		ctx.fillStyle = "#FFFFFF";
		ctx.font = "bold 120px sans-serif";
		ctx.textAlign = "center";
		ctx.fillText(
			tokenName.substring(0, 1).toUpperCase(),
			width / 2,
			tokenY + 40,
		);

		// Footer with timestamp
		ctx.fillStyle = "#94A3B8";
		ctx.font = "20px sans-serif";
		ctx.textAlign = "center"; // Ensure center alignment for footer
		ctx.fillText(
			`Generated by Farcaster Trending Bot • ${new Date().toISOString()}`,
			width / 2,
			height - 40,
		);

		spinner.succeed("Token image generated successfully");
		// Save image to buffer
		return canvas.toBuffer("image/png");
	} catch (error) {
		spinner.fail("Failed to generate token image");
		console.error(chalk.red("Error generating image:"), error);
		throw error;
	}
};

const uploadImageToIPFS = async (imageBuffer: Buffer): Promise<IPFSResult> => {
	const spinner = ora("Uploading image to IPFS...").start();
	try {
		const sizeInBytes = imageBuffer.length;
		// Save buffer to temporary file
		const tempFilePath = path.join("/tmp", `token-image-${Date.now()}.png`);
		fs.writeFileSync(tempFilePath, imageBuffer);

		// Upload to Pinata
		spinner.text = "Requesting Pinata upload URL...";
		const response = await fetchWithPayment(
			"https://402.pinata.cloud/v1/pin/public",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					fileSize: sizeInBytes + 500, // The size of the file + 500 bytes buffer
				}),
			},
		);

		const urlData = await response.json();

		spinner.text = "Uploading file to Pinata...";
		const blob = new Blob([fs.readFileSync(tempFilePath)]);
		const file = new File([blob], `token-image-${Date.now()}.png`, {
			type: "image/png",
		});
		const upload = await pinata.upload.public.file(file).url(urlData.url);
		// Clean up temp file
		fs.unlinkSync(tempFilePath);

		spinner.succeed(
			`Successfully uploaded to IPFS: ${chalk.cyan(`ipfs://${upload.cid}`)}`,
		);

		return {
			cid: upload.cid,
			url: `https://gateway.pinata.cloud/ipfs/${upload.cid}`,
		};
	} catch (error) {
		spinner.fail("Failed to upload to IPFS");
		console.error(chalk.red("Error uploading to IPFS:"), error);
		throw error;
	}
};

const deployToken = async (
	media: string,
	tokenName: string,
	tokenSymbol: string,
): Promise<TokenDeployResult> => {
	const spinner = ora(
		`Deploying token ${chalk.cyan(tokenName)} (${chalk.yellow(tokenSymbol)})...`,
	).start();
	const formData = new FormData();
	formData.append("owner", "0x158E38AD1FF422A522aC253c87343F5171692B92");
	formData.append("symbol", tokenSymbol);
	formData.append("name", tokenName);
	formData.append(
		"metadata[description]",
		"Generated token based on trending Farcaster content",
	);
	formData.append("metadata[media]", media);

	try {
		const formDataBuffer = formData.getBuffer ? formData.getBuffer() : formData;
		const formHeaders = formData.getHeaders ? formData.getHeaders() : {};

		spinner.text = "Submitting token deployment request...";
		const response = await fetchWithPayment(
			"https://api.neynar.com/v2/fungible",
			{
				method: "POST",
				headers: {
					...formHeaders,
				},
				//  @ts-expect-error
				body: formDataBuffer,
			},
		);

		const paymentResponse = decodeXPaymentResponse(
			response.headers.get("x-payment-response") as string,
		);
		console.log(chalk.cyan("Payment response:"), paymentResponse);

		const responseText = await response.text();

		if (!response.ok) {
			let errorData: Record<string, any> = {};
			try {
				errorData = JSON.parse(responseText);
			} catch (e) {
				errorData = { message: responseText };
			}
			spinner.fail("Token deployment failed");
			console.log(chalk.red("Error!"));
			console.log(chalk.red(JSON.stringify(errorData)));
			throw new Error(errorData.message || "Request failed");
		}

		const data = JSON.parse(responseText);
		spinner.succeed(`Token ${chalk.green(tokenName)} deployed successfully!`);
		console.log(chalk.green("Token deployed details:"), data);
		return data;
	} catch (error: unknown) {
		spinner.fail("Token deployment failed");
		if (error instanceof Error) {
			console.error(chalk.red("Error deploying token:"), error.message);
		} else {
			console.error(chalk.red("Unknown error deploying token"));
		}

		// Safely access error properties if they exist
		if (error && typeof error === "object" && "response" in error) {
			const errorWithResponse = error as { response?: { data?: unknown } };
			if (errorWithResponse.response?.data) {
				console.error(
					chalk.red("Response data:"),
					errorWithResponse.response.data,
				);
			}
		}

		throw error;
	}
};

/**
 * Main process to run at scheduled intervals
 */
const processTrendingCasts = async () => {
	const mainSpinner = ora(
		chalk.bold("Starting trending casts process"),
	).start();
	try {
		mainSpinner.info(
			chalk.blue(
				`Starting trending casts process: ${new Date().toISOString()}`,
			),
		);

		// 1. Fetch trending casts
		const castData = await getTrendingCasts();
		mainSpinner.succeed(
			chalk.green(
				`Retrieved ${chalk.bold(castData.casts?.length || 0)} trending casts`,
			),
		);

		// 2. Use LLM to select the best cast for a crypto token
		mainSpinner.text = "Analyzing casts with LLM...";
		const llmResult = await selectBestCastWithLLM(castData.casts);

		console.log(
			chalk.yellow.bold("LLM selected cast:"),
			chalk.yellow(llmResult.cast.text.substring(0, 100) + "..."),
		);
		console.log(
			chalk.magenta.bold("Suggested token name:"),
			chalk.magenta(llmResult.tokenName),
		);
		console.log(
			chalk.cyan.bold("Image description:"),
			chalk.cyan(llmResult.imageDescription),
		);

		// 3. Generate image for the selected cast
		mainSpinner.text = "Generating token image...";
		const imageBuffer = await generateImageForCast(
			llmResult.cast,
			llmResult.tokenName,
		);
		mainSpinner.succeed(chalk.green("Generated token image"));

		// Save to temp file for IPFS upload
		const tempFilePath = path.join("/tmp", `token-image-${Date.now()}.png`);
		fs.writeFileSync(tempFilePath, imageBuffer);

		// 4. Upload to IPFS
		mainSpinner.text = "Uploading to IPFS...";
		const ipfsResult = await uploadImageToIPFS(imageBuffer);
		mainSpinner.succeed(
			chalk.green(
				`Uploaded image to IPFS: ${chalk.blue.underline(ipfsResult.url)}`,
			),
		);

		// 5. Save image locally as well
		mainSpinner.text = "Saving image locally...";
		const imagePath = path.join("images", `token-${Date.now()}.png`);
		fs.mkdirSync("images", { recursive: true });
		fs.writeFileSync(imagePath, imageBuffer);
		mainSpinner.succeed(chalk.green(`Saved image to ${chalk.blue(imagePath)}`));

		// 6. Save metadata to file (for historical reference)
		mainSpinner.text = "Saving metadata...";
		const metadata = {
			timestamp: new Date().toISOString(),
			selectedCast: {
				hash: llmResult.cast.hash,
				text: llmResult.cast.text,
				author: llmResult.cast.author,
				created_at: llmResult.cast.created_at,
			},
			llmResponse: llmResult.llmResponse,
			tokenName: llmResult.tokenName,
			imageDescription: llmResult.imageDescription,
			ipfs: ipfsResult,
		};

		const metadataFilePath = path.join(
			"data",
			`token-metadata-${Date.now()}.json`,
		);
		fs.mkdirSync("data", { recursive: true });
		fs.writeFileSync(metadataFilePath, JSON.stringify(metadata, null, 2));
		mainSpinner.succeed(
			chalk.green(`Saved metadata to ${chalk.blue(metadataFilePath)}`),
		);

		// 7. Deploy the token
		mainSpinner.text = "Preparing token deployment...";
		console.log(chalk.cyan("Deployment parameters:"));
		console.log(`  URL: ${chalk.blue(`ipfs://${ipfsResult.cid}`)}`);
		console.log(`  Token Name: ${chalk.yellow(llmResult.tokenName)}`);
		console.log(
			`  Symbol: ${chalk.yellow(llmResult.tokenName?.substring(0, 4).toUpperCase())}`,
		);

		const deployResult = await deployToken(
			`ipfs://${ipfsResult.cid}`,
			llmResult.tokenName,
			llmResult.tokenName?.substring(0, 4).toUpperCase(),
		);

		mainSpinner.succeed(
			chalk.bold.green("✨ Process completed successfully! ✨"),
		);

		console.log(
			`🔵 Visit Token: https://basescan.org/address/${deployResult.contract.fungible.address}`,
		);

		return {
			selectedCast: llmResult.cast,
			tokenName: llmResult.tokenName,
			image: {
				local: imagePath,
				ipfs: ipfsResult,
			},
			deploy: deployResult,
		};
	} catch (error) {
		mainSpinner.fail(chalk.red.bold("Process failed!"));
		console.error(chalk.red("Error in processTrendingCasts:"), error);
		throw error;
	}
};

// Setup cron schedule
const setupCronJob = () => {
	// Run every hour on the hour
	cron.schedule("0 * * * *", async () => {
		try {
			console.log(
				chalk.blue.bold("\n🚀 Running scheduled trending casts aggregation"),
			);
			await processTrendingCasts();
			console.log(
				chalk.green.bold("✅ Completed scheduled trending casts aggregation"),
			);
		} catch (error) {
			console.error(
				chalk.red.bold("❌ Error in scheduled trending casts aggregation:"),
				error,
			);
		}
	});

	console.log(
		chalk.blue.bold("⏰ Scheduled trending casts aggregation to run hourly"),
	);
};

(async () => {
	try {
		console.log(chalk.blue.bold("🚀 Starting trending casts token generator"));
		// Run once immediately
		await processTrendingCasts();

		// Then setup scheduled runs
		// Uncomment to enable scheduled runs
		// setupCronJob();
	} catch (error) {
		console.error(
			chalk.red.bold("❌ Error running trending casts service:"),
			error,
		);
	}
})();
