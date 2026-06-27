import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

// API Key ကို GitHub Secrets (Environment variable) မှ ယူခြင်း
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// မိတ်ဆွေ၏ M3U Playlist Source URL
const M3U_URL = "https://tivimate-iptv.nyinyihan17.workers.dev/playlist.m3u";

// ရွေးထုတ်လိုသော Group နာမည်များတွင် ပါဝင်သည့် သင်္ကေတများ သတ်မှတ်ခြင်း
const TARGET_MARKS = ['⭐', '✨']; 

async function generateMapping() {
    console.log(`🔄 Fetching Playlist from: ${M3U_URL}`);

    try {
        // 1. URL မှ M3U ဖိုင်ကို ဆွဲယူခြင်း
        const response = await fetch(M3U_URL);
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const m3uText = await response.text();

        const lines = m3uText.split('\n');
        const channelNames = new Set(); 

        // 2. M3U ကို ဖတ်ပြီး သတ်မှတ်ထားသော Group မှ Channel များကိုသာ ရွေးထုတ်ခြင်း
        lines.forEach(line => {
            if (line.startsWith('#EXTINF:')) {
                // group-title ကို ရှာဖွေခြင်း
                const groupMatch = line.match(/group-title="([^"]+)"/i);
                const groupTitle = groupMatch ? groupMatch[1] : "";

                // Channel နာမည်ကို ရှာဖွေခြင်း (နောက်ဆုံး ကော်မာ နောက်က စာသား)
                const channelNameMatch = line.match(/,(.+?)$/);
                const channelName = channelNameMatch ? channelNameMatch[1].trim() : "";

                // Group Name ထဲတွင် ⭐ သို့မဟုတ် ✨ ပါမပါ စစ်ဆေးခြင်း
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

        // Gemini 2.5 Flash Model ကို ခေါ်ယူခြင်း
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
        
        let finalMappingData = {};
        const chunkSize = 100; // API Limit သက်သာစေရန် တစ်ခါပို့လျှင် Channel ၁၀၀ စီခွဲပို့မည်

        // 3. Channel များကို ခွဲ၍ Gemini သို့ ပို့ခြင်း
        for (let i = 0; i < uniqueChannels.length; i += chunkSize) {
            const chunk = uniqueChannels.slice(i, i + chunkSize);
            console.log(`🧠 Sending chunk ${Math.floor(i / chunkSize) + 1} of ${Math.ceil(uniqueChannels.length / chunkSize)} (${chunk.length} channels) to Gemini AI...`);
            
            const prompt = `
            You are an expert IPTV architect. Match the following M3U channel names with the closest appropriate EPG Channel ID from the epg.pw database.
            Return ONLY a valid JSON object where the key is the exact M3U channel name, and the value is the matched epg.pw Channel ID. 
            Do not include markdown code blocks (like \`\`\`json), do not add any explanations. Just return the raw JSON string.
            If you cannot find a match, use an empty string "" as the value.

            Channels to match: ${JSON.stringify(chunk)}
            `;

            let success = false;
            let retries = 3; // Error တက်ခဲ့လျှင် အများဆုံး ၃ ကြိမ်အထိ ပြန်လည်ကြိုးစားမည်

            while (!success && retries > 0) {
                try {
                    const result = await model.generateContent(prompt);
                    let jsonResponse = result.response.text();
                    
                    // AI ပြန်ပေးသော စာသားထဲမှ JSON အပိုင်းကိုသာ သီးသန့်ဖြတ်ယူခြင်း
                    jsonResponse = jsonResponse.replace(/```json/ig, "").replace(/```/g, "").trim();
                    const jsonStart = jsonResponse.indexOf('{');
                    const jsonEnd = jsonResponse.lastIndexOf('}');
                    
                    if (jsonStart !== -1 && jsonEnd !== -1) {
                        jsonResponse = jsonResponse.substring(jsonStart, jsonEnd + 1);
                    }

                    const mappingData = JSON.parse(jsonResponse);
                    
                    // ရလာသော Mapping အသစ်များကို အဓိက Data ထဲသို့ ပေါင်းထည့်ခြင်း
                    finalMappingData = { ...finalMappingData, ...mappingData };
                    
                    success = true; // အောင်မြင်ပါက While Loop ထဲမှ ထွက်မည်

                    // API 15 RPM Limit မကျော်စေရန် ပုံမှန်အားဖြင့် ၅ စက္ကန့် နားမည်
                    console.log(`✅ Chunk ${Math.floor(i / chunkSize) + 1} processed successfully. Waiting 5 seconds...`);
                    await new Promise(resolve => setTimeout(resolve, 5000)); 

                } catch (apiError) {
                    retries--;
                    console.error(`⚠️ API Error on chunk ${Math.floor(i / chunkSize) + 1}: ${apiError.message}`);
                    
                    if (retries > 0) {
                        // Rate Limit (သို့) တခြား Error တက်ပါက ၃၀ စက္ကန့်နားပြီးမှ ပြန်ကြိုးစားမည်
                        console.log(`⏳ Waiting 30 seconds before retry... (${retries} retries left)`);
                        await new Promise(resolve => setTimeout(resolve, 30000)); 
                    } else {
                        console.log("❌ Failed after multiple retries. Skipping this chunk.");
                    }
                }
            }
        }

        // 4. Mapping အားလုံးကို JSON ဖိုင်အဖြစ် သိမ်းဆည်းခြင်း
        fs.writeFileSync("channel_mapping.json", JSON.stringify(finalMappingData, null, 2));
        console.log(`🎉 AI Mapping Completed! Successfully saved ${Object.keys(finalMappingData).length} mapped channels to channel_mapping.json`);

    } catch (error) {
        console.error("❌ Error during Auto-Mapping Process:", error);
        process.exit(1); // Error ကြီးကြီးမားမားတက်ပါက GitHub Action ကို Fail ဖြစ်စေမည်
    }
}

generateMapping();