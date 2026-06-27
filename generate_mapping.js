import fs from "fs";

// API Keys များကို ခွဲခြားယူခြင်း
const rawKeys = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "";
const apiKeys = rawKeys.split(/[\n\r,]+/).map(key => key.trim()).filter(key => key.length > 0);

if (apiKeys.length === 0) {
    console.error("❌ No API Keys found! Please set GROQ_API_KEY in GitHub Secrets.");
    process.exit(1);
}

console.log(`🔑 Loaded ${apiKeys.length} Groq API keys for rotation.`);
let currentKeyIndex = 0;

const M3U_URL = "https://iu-ott.akvado-lso123.workers.dev/ott.m3u?user-agent=vj-14-1ogfiva";
const EPG_URL = "https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz";

async function generateFinalM3U() {
    console.log(`🔄 Fetching Original Playlist from: ${M3U_URL}`);

    try {
        const response = await fetch(M3U_URL, {
            headers: { "User-Agent": "vj-14-1ogfiva" }
        });
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const m3uText = await response.text();

        const lines = m3uText.split('\n');
        const filteredChannels = [];
        let currentExtinf = "";
        let droppedCount = 0;

        console.log("🧹 Filtering Russian channels and grouping sports...");

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                currentExtinf = line;
            } else if (line.startsWith('http') && currentExtinf !== "") {
                let groupMatch = currentExtinf.match(/group-title="([^"]*)"/i);
                let groupTitle = groupMatch ? groupMatch[1] : "";
                let nameMatch = currentExtinf.match(/,(.+?)$/);
                let channelName = nameMatch ? nameMatch[1].trim() : "";

                // ရုရှားစာ (Cyrillic) ပါဝင်သော Group များအားလုံးကို အလိုအလျောက် ဖမ်းယူခြင်း
                // \u0400-\u04FF သည် ရုရှားအက္ခရာများအားလုံးကို သိမ်းကျုံးဖမ်းယူနိုင်သော Unicode ဖြစ်ပါသည်
                const isRuGroup = /[\u0400-\u04FF]|Russia|🇷🇺|\bru\b/i.test(groupTitle);
                
                // အားကစားလိုင်း ဟုတ်/မဟုတ် စစ်ဆေးခြင်း
                const isSport = /sport|спорт|match|футбол|арена|бойцовский|ufc|arena|football/i.test(channelName) || /sport|спорт/i.test(groupTitle);

                let keep = true;

                if (isRuGroup) {
                    if (isSport) {
                        // ရုရှား Group ထဲမှ အားကစားလိုင်းဖြစ်ပါက Group နာမည်ကို "Sport from Russia GP" သို့ ပြောင်းမည်
                        if (groupMatch) {
                            currentExtinf = currentExtinf.replace(`group-title="${groupTitle}"`, `group-title="Sport from Russia GP"`);
                        } else {
                            currentExtinf = currentExtinf.replace('#EXTINF:-1', '#EXTINF:-1 group-title="Sport from Russia GP"');
                        }
                        groupTitle = "Sport from Russia GP";
                    } else {
                        // ရုရှား Group တွင်းရှိ အားကစားမဟုတ်သော တခြားလိုင်းများကို ဖြုတ်ချမည်
                        keep = false;
                        droppedCount++;
                    }
                }

                if (keep && channelName) {
                    filteredChannels.push({
                        extinf: currentExtinf,
                        url: line,
                        name: channelName,
                        group: groupTitle
                    });
                }
                
                currentExtinf = "";
            }
        }

        console.log(`✅ Kept ${filteredChannels.length} channels. Dropped ${droppedCount} non-sport Russian channels.`);

        let finalMappingData = {};
        const chunkSize = 30; // Token Limit မကျော်စေရန် လိုင်း ၃၀ သို့ လျှော့ချထားပါသည်

        // ၂။ Groq AI ဖြင့် epgshare01 EPG ID များကို Map လုပ်ခြင်း
        for (let i = 0; i < filteredChannels.length; i += chunkSize) {
            const chunk = filteredChannels.slice(i, i + chunkSize);
            const chunkNumber = Math.floor(i / chunkSize) + 1;
            const totalChunks = Math.ceil(filteredChannels.length / chunkSize);
            
            console.log(`🧠 Groq AI Mapping chunk ${chunkNumber} of ${totalChunks} (${chunk.length} channels)...`);
            
            const aiPromptData = chunk.map(c => ({ channel_name: c.name, context: c.group }));

            const prompt = `
            You are an expert IPTV architect. Match the following channels with the exact EPG Channel ID from the "epgshare01.online" database.
            Use the provided "context" (which includes country names or flags like 🇬🇧, 🇺🇸) to accurately determine the country and select the correct EPG ID.
            Return ONLY a valid JSON object where the key is the exact "channel_name", and the value is the matched epgshare01 Channel ID.
            Do not include markdown blocks. Just return raw JSON. If no match is found, return "".

            Data: ${JSON.stringify(aiPromptData)}
            `;

            let success = false;
            let retries = apiKeys.length * 2; 

            while (!success && retries > 0) {
                const currentApiKey = apiKeys[currentKeyIndex];
                try {
                    const aiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${currentApiKey}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            model: "llama-3.3-70b-versatile", // Groq ၏ အသစ်ဆုံးနှင့် အတည်ငြိမ်ဆုံး မော်ဒယ်
                            messages: [{ role: "user", content: prompt }],
                            temperature: 0.1
                        })
                    });

                    if (!aiResponse.ok) {
                        const errData = await aiResponse.text();
                        throw new Error(`Groq API Error: ${aiResponse.status} - ${errData}`);
                    }

                    const aiData = await aiResponse.json();
                    let jsonResponse = aiData.choices[0].message.content;
                    
                    jsonResponse = jsonResponse.replace(/```json/ig, "").replace(/```/g, "").trim();
                    const jsonStart = jsonResponse.indexOf('{');
                    const jsonEnd = jsonResponse.lastIndexOf('}');
                    
                    if (jsonStart !== -1 && jsonEnd !== -1) {
                        jsonResponse = jsonResponse.substring(jsonStart, jsonEnd + 1);
                    }

                    const mappingData = JSON.parse(jsonResponse);
                    finalMappingData = { ...finalMappingData, ...mappingData };
                    success = true; 
                    
                    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                    await new Promise(resolve => setTimeout(resolve, 3000)); 

                } catch (apiError) {
                    retries--;
                    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                    if (retries > 0) {
                        console.log(`⚠️ Error: ${apiError.message}. Retrying with next key... (${retries} left)`);
                        await new Promise(resolve => setTimeout(resolve, 5000)); 
                    } else {
                        console.log(`❌ Failed chunk ${chunkNumber} after multiple retries.`);
                    }
                }
            }
        }

        // ၃။ အသင့်အသုံးပြုနိုင်သော M3U ဖိုင်အသစ် တည်ဆောက်ခြင်း
        console.log("📝 Generating final_playlist.m3u...");
        
        let m3uOutput = `#EXTM3U x-tvg-url="${EPG_URL}"\n`; 
        
        for (const ch of filteredChannels) {
            let extinf = ch.extinf;
            let tvgId = finalMappingData[ch.name];

            if (tvgId && tvgId !== "") {
                if (extinf.includes('tvg-id=')) {
                    extinf = extinf.replace(/tvg-id="[^"]*"/, `tvg-id="${tvgId}"`);
                } else {
                    extinf = extinf.replace('#EXTINF:-1', `#EXTINF:-1 tvg-id="${tvgId}"`);
                }
            }
            m3uOutput += `${extinf}\n${ch.url}\n`;
        }

        fs.writeFileSync("final_playlist.m3u", m3uOutput, "utf-8");
        console.log(`🎉 Success! Generated 'final_playlist.m3u' with ${filteredChannels.length} formatted channels.`);

    } catch (error) {
        console.error("❌ Fatal Error:", error);
        process.exit(1); 
    }
}

generateFinalM3U();
