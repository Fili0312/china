import { Module } from "@nestjs/common";
import { InquiryModule } from "./inquiry/inquiry.module";
import { QuotesModule } from "./quotes/quotes.module";
import { SearchModule } from "./search/search.module";

@Module({
  imports: [QuotesModule, SearchModule, InquiryModule],
})
export class AppModule {}
