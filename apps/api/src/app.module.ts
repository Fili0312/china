import { Module } from "@nestjs/common";
import { InquiryModule } from "./inquiry/inquiry.module";
import { QuotesModule } from "./quotes/quotes.module";
import { ScoutingModule } from "./scouting/scouting.module";
import { SearchModule } from "./search/search.module";

@Module({
  imports: [QuotesModule, SearchModule, InquiryModule, ScoutingModule],
})
export class AppModule {}
