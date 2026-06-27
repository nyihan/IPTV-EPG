        console.log(`✅ Successfully mapped ${mappedCount} out of ${filteredChannels.length} channels.`);

        // ၄။ အသင့်အသုံးပြုနိုင်သော M3U ဖိုင်အသစ် တည်ဆောက်ခြင်း
        console.log("📝 Generating final_playlist.m3u...");
        let m3uOutput = `#EXTM3U x-tvg-url="${EPG_URL}"\n`; 
        
        for (const ch of filteredChannels) {
            m3uOutput += `${ch.extinf}\n${ch.url}\n`;
        }

        fs.writeFileSync("final_playlist.m3u", m3uOutput, "utf-8");
        console.log(`🎉 Success! Generated 'final_playlist.m3u' ready for TiviMate.`);

    } catch (error) {
        console.error("❌ Fatal Error:", error);
        process.exit(1); 
    }
}

generateFinalM3U();
