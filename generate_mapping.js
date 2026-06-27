import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

// API Keys များကို Enter ခေါက်ထားခြင်း (\n) သို့မဟုတ် ကော်မာ (,) နှစ်မျိုးလုံးကို နားလည်ပြီး ခွဲခြားပေးမည့်စနစ်
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
// ပုံမှန် split(',') အစား Regular Expression ကိုသုံး၍ Enter များကိုပါ ခွဲထုတ်ခြင်း
const apiKeys = rawKeys.split(/[\n\r,]+/).map(key => key.trim()).filter(key => key.length > 0);

if (apiKeys.length === 0) {
    console.error("❌ No API Keys found! Please set GEMINI_API_KEY in GitHub Secrets.");
    process.exit(1);
}

console.log(`🔑 Loaded ${apiKeys.length} API keys for rotation.`);

// Key တစ်ခုချင်းစီအတွက် Gemini 2.5 Flash Model များကို ကြိုတင်ပြင်ဆင်ထားခြင်း
const models = apiKeys.map(key => new GoogleGenerativeAI(key).getGenerativeModel({ model: "gemini-2.5-flash" }));
let currentKeyIndex = 0; // ပထမဆုံး Key မှ စတင်မည်

const M3U_URL = "https://tivimate-iptv.nyinyihan17.workers.dev/playlist.m3u";
const TARGET_MARKS = ['⭐', '✨']; 

async function generateMapping() {
    console.log(`🔄 Fetching Playlist from: ${M3U_URL}`);

    try {
        const response = await fetch(M3U_URL);
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const m3uText = await response.text();

        const lines = m3uText.split('\n');
        const channelNames = new Set(); 

        lines.forEach(line => {
            if (line.startsWith('#EXTINF:')) {
                const groupMatch = line.match(/group-title="([^"]+)"/i);
                const groupTitle = groupMatch ? groupMatch[1] : "";

                const channelNameMatch = line.match(/,(.+?)$/);
                const channelName = channelNameMatch ? channelNameMatch[1].trim() : "";

                const hasTargetMark = TARGET_MARKS.some(mark => groupTitle.includes(mark));

                if (channelName && hasTargetMark) {
                    channelNames.add(channelName);
                }
            }
        });

        const uniqueChannels = Array.from(channelNames);
        console.log(`✅ Found ${uniqueChannels.length} target channels with ⭐ or ✨ marks.`);

        if (uniqueChannels.length === 0) {
            console.log("⚠️ No marked channels found. Exiting...");
            return;
        }
        
        let finalMappingData = {};
        const chunkSize = 100; 

        for (let i = 0; i < uniqueChannels.length; i += chunkSize) {
            const chunk = uniqueChannels.slice(i, i + chunkSize);
            const chunkNumber = Math.floor(i / chunkSize) + 1;
            const totalChunks = Math.ceil(uniqueChannels.length / chunkSize);
            
            console.log(`🧠 Sending chunk ${chunkNumber} of ${totalChunks} (${chunk.length} channels)...`);
            
            const prompt = `
            You are an expert IPTV architect. Match the following M3U channel names with the closest appropriate EPG Channel ID from the epg.pw database.
            Return ONLY a valid JSON object where the key is the exact M3U channel name, and the value is the matched epg.pw Channel ID. 
            Do not include markdown code blocks (like \`\`\`json), do not add any explanations. Just return the raw JSON string.
            If you cannot find a match, use an empty string "" as the value.

            Channels to match: ${JSON.stringify(chunk)}
            `;

            let success = false;
            // Key အရေအတွက်အပေါ် မူတည်ပြီး Retry အကြိမ်ရေကို တိုးထားပါသည် (ဥပမာ- 4 keys ဆိုလျှင် 8 ကြိမ် အထိ ပြန်ခေါ်မည်)
            let retries = apiKeys.length * 2; 

            while (!success && retries > 0) {
                // လက်ရှိအလှည့်ကျနေသော Key (Model) ကို အသုံးပြုခြင်း
                const model = models[currentKeyIndex];
                
                try {
                    console.log(`📡 Using API Key #${currentKeyIndex + 1}...`);
                    const result = await model.generateContent(prompt);
                    let jsonResponse = result.response.text();
                    
                    jsonResponse = jsonResponse.replace(/```json/ig, "").replace(/```/g, "").trim();
                    const jsonStart = jsonResponse.indexOf('{');
                    const jsonEnd = jsonResponse.lastIndexOf('}');
                    
                    if (jsonStart !== -1 && jsonEnd !== -1) {
                        jsonResponse = jsonResponse.substring(jsonStart, jsonEnd + 1);
                    }

                    const mappingData = JSON.parse(jsonResponse);
                    finalMappingData = { ...finalMappingData, ...mappingData };
                    
                    success = true; 

                    console.log(`✅ Chunk ${chunkNumber} processed successfully.`);
                    
                    // အောင်မြင်သွားပါက နောက် Chunk အတွက် Key အသစ်သို့ ပြောင်းထားမည် (Round-Robin)
                    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                    
                    // ပုံမှန်အားဖြင့် ၃ စက္ကန့်သာ နားမည် (Key များနေသဖြင့် အကြာကြီးနားစရာမလိုတော့ပါ)
                    await new Promise(resolve => setTimeout(resolve, 3000)); 

                } catch (apiError) {
                    retries--;
                    console.error(`⚠️ API Error on Key #${currentKeyIndex + 1}: ${apiError.message}`);
                    
                    // Error တက်ပါက ကျန်နေသေးသော နောက်ထပ် Key တစ်ခုသို့ ချက်ချင်း ပြောင်းလဲမည်
                    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                    
                    if (retries > 0) {
                        console.log(`🔄 Switching to Key #${currentKeyIndex + 1}. Waiting 5 seconds before retry... (${retries} retries left)`);
                        await new Promise(resolve => setTimeout(resolve, 5000)); 
                    } else {
                        console.log("❌ Failed after multiple retries with all keys. Skipping this chunk.");
                    }
                }
            }
        }

        fs.writeFileSync("channel_mapping.json", JSON.stringify(finalMappingData, null, 2));
        console.log(`🎉 AI Mapping Completed! Successfully saved ${Object.keys(finalMappingData).length} mapped channels to channel_mapping.json`);

    } catch (error) {
        console.error("❌ Error during Auto-Mapping Process:", error);
        process.exit(1); 
    }
}

generateMapping();